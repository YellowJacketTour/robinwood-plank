# Plank Live Laboratory: HUD, Storyboard, Continuity, and Mainnet Boundary

Date: 2026-08-27
Status: implementation specification; simulation has no monetary value

## Product truth

The interface has two simultaneous duties:

1. make a rising-multiplier game feel immediate, legible, social, and spectacular;
2. make the economic and network truth more visible than any competing crash game.

Animation is never authority. The canonical sequence is a signed/recorded server or chain event stream. The client interpolates the multiplier and predicts only presentation. A lock press receives immediate tactile/visual acknowledgement as **SENDING**, then becomes **LOCKED AT x** only after an authoritative receipt. Rejection is explicit and leaves a durable receipt; the UI must never quietly rewrite a predicted success.

Valve's client/server literature supports prediction followed by authoritative reconciliation, while also emphasizing that packets remain mutable and the server owns rules and state ([Source multiplayer networking](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking), [latency-compensating protocol design](https://developer.valvesoftware.com/wiki/Latency_Compensating_Methods_in_Client/Server_In-game_Protocol_Design_and_Optimization)). Plank applies that model to presentation only, not to economic entitlement.

## Evidence-driven constraints

- Established crash products present a short betting window, optional target, a rising multiplier, multiplayer participation, statistics, and a fairness surface. Stake currently documents an approximately five-second betting window and separate manual/automatic modes ([Stake Crash](https://stake.bet/casino/games/crash?game=crash)). Plank should retain the learnable grammar but expose materially more accounting and receipt detail.
- Hash-chain providers commonly emphasize that outcomes were committed before wagering. BC.Game describes reverse disclosure of a precomputed hash chain ([BC provably fair](https://whitepaper.bc.game/bc-white-paper/appendix/provably-fair)). Plank's UI must show commitment, randomness round, reveal/finality, and a one-click local verification result—not merely a “provably fair” badge.
- WCAG 2.2 requires visible focus, alternatives to dragging, minimum target sizing, status semantics, and control of nonessential motion. Enhanced pointer targets are 44x44 CSS pixels; the AA minimum is 24x24 with spacing exceptions ([WCAG 2.2](https://www.w3.org/TR/wcag/)). Plank uses a 48 CSS-pixel minimum for primary live actions.
- Real-time events can be intrinsically timed, but setup, rules, history, limits, and receipts do not need to disappear. Auto-updating information requires a stable history/static alternative ([W3C timing guidance](https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable)).
- Regulatory design requirements vary by jurisdiction. The UK Gambling Commission's RTS includes time-critical events, interrupted play, transaction display, limits, reality checks, result determination, progressive jackpots, and responsible product design; current guidance also prohibits autoplay and adds speed restrictions in covered products ([UKGC RTS](https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/3-remote-gambling-and-software-technical-standards)). Consequently, simulation automation is an operator test instrument, never presumed acceptable for public real-value play.

## Canonical round storyboard

### 0. Access and orientation

- Passkey authentication.
- Persistent banner: `SIMULATION · NO VALUE · TEST CREDITS`.
- Room identity, rules hash, participant count, server time offset, region/build, and connection state.
- First visit shows a concise rules card: loss condition, PFSS allocation, 4.50% rake, 20/40/remainder destinations, Powerboard fee, and how to verify.
- No forced cinematic. “Enter cockpit” retains reduced-motion and contrast preferences.

### 1. Lobby / settled intermission

- Main action region says `NEXT FLIGHT` rather than displaying an inert cash-out button.
- Stake input, target/auto-lock input, clear min/max, expected *rule mechanics*—never misleading expected winnings.
- Player may submit, amend, or cancel until the published cutoff.
- The roster shows committed stakes, not private wallet information.
- Jackpot panel distinguishes guaranteed net prize, reset coverage, pending funding, and founder fee already escrowed.

### 2. Betting closes

- Controls freeze from the server event, not a client timer.
- A compact manifest appears: player count, total stake, commitment, applicable rules hash, and round ID.
- Late commands receive a durable `BETTING_CLOSED` receipt with server receive time.

### 3. Launch / running

- Multiplier is the dominant datum, visually and semantically.
- Primary action becomes `LOCK NOW`; keyboard shortcut is documented and disabled when focus is in an editable control.
- The local HUD shows stake, requested/sending/accepted state, accepted multiplier, and projected PFSS status.
- The server time rail and connection badge remain visible. Never imply that a smooth animation means connectivity.
- Other players' accepted locks appear as discrete events. Their animations are decorative; a table/history holds the accessible record.

### 4. Lock reconciliation

- On press: immediate pressed state, haptic feedback when supported, unique command ID, `SENDING` chip.
- On acceptance: `LOCKED 2.41x`, authoritative received/accepted timestamps, server sequence, receipt hash.
- On rejection: strong non-color-only failure state, reason, current connection state, immutable command receipt.
- Never compensate by accepting a client-declared time. Mainnet uses contract inclusion/defined chain rules; the lab records both client intent time and authoritative receive time to measure the gap.

### 5. Crash

- Multiplier freezes at the exact canonical crash value.
- Motion can intensify only within photosensitivity/reduced-motion policy.
- The result region immediately states survived/busted, accepted target, stake, PFSS base, surplus, payout, and net change.
- A crash must not obscure the receipt, focus, or controls.

### 6. Settlement and proof

- Accounting identity: seed + wagers = rake + distributable; distributable = payouts + Vault remainder.
- Rake waterfall: keeper first, then 20% burn / 40% community / remainder founders from net rake.
- Community waterfall: protected principal, emissions, crash seed, overflow to lottery.
- Powerboard: constituted gross, recurring founder fee including rollover provenance, displayed net winner-take-all prize, higher fully covered reset base.
- Fairness proof: commitment, randomness input, reveal, recomputed crash, pass/fail, implementation/source version.
- `Copy receipt`, `Export round JSON`, and `Verify locally` remain accessible from history.

### 7. Continuity / next round

- The next betting state starts from a new server event; the prior receipt stays inspectable.
- Stake and target may be prefilled, but no real-value wager is resubmitted automatically.
- Focus moves only when the user initiates it. Screen readers receive a concise status update, not every animation frame.

## HUD hierarchy

### Always-visible safety rail

1. simulation/mainnet environment;
2. connection: live, delayed, reconnecting, offline;
3. server time offset and last authoritative event age;
4. room, round, rules hash shortcut;
5. session duration and test-credit balance;
6. limits/reality-check control.

### Primary play plane

1. phase and countdown based on server timestamps;
2. multiplier;
3. one primary action;
4. local stake and target/accepted lock;
5. concise command receipt state.

### Social plane

- participant roster;
- stake/lock/result events;
- deterministic spectator mode;
- optional chat later, separated from transaction controls and fully mutable/moderated.

### Economic dashboard

- round pool and player distribution;
- rake destinations;
- Vault protected principal and emission buffer;
- Powerboard current net prize, high-water mark, pending growth, reset reserve, and next base;
- founder revenue separated into crash rake and lottery-engine fee;
- exact conservation check.

### History/proof drawer

- append-only event sequence;
- command IDs and outcomes;
- round JSON and replay;
- fairness verification;
- network timing diagnostics;
- no disappearing toast as the sole record.

## State grammar

Every actionable object uses the same vocabulary:

`EDITABLE -> SUBMITTING -> ACCEPTED | REJECTED | UNKNOWN`

`UNKNOWN` is mandatory after a timeout: the client must query by idempotency key rather than invite a duplicate command. Economic commands use unique IDs, server-side uniqueness constraints, transactional state-version checks, and an exact response replay on retry.

The implemented laboratory reconciles a failed response by querying the exact
command UUID through the authenticated append-only receipt endpoint. It does
not scan only the newest or oldest page and it does not mint a replacement UUID.
Only if no receipt exists does the UI report the command as unresolved.

Room snapshots contain:

- monotonic `version` and append-only event `sequence`;
- authoritative `serverNow`;
- phase deadlines as absolute timestamps;
- round commitment/result fields;
- player-safe public state;
- current user's private command/receipt state;
- exact serialized BigInt accounting;
- rules/schema/build versions.

The client continuously estimates `serverNow - localNow` from snapshot and
long-poll heartbeat responses and drives its visual curve/deadline from that
offset. This is presentation synchronization only: the server's receive time
still decides lock acceptance, so changing a device clock cannot create an
economic entitlement.

## Multiplayer transport

The durable source is PostgreSQL, not process memory. The laboratory uses a
resumable long poll keyed by monotonic room version: it returns immediately on
change, otherwise waits at most 20 seconds, releases every query connection,
and cleans up its timer on request abort. This works across Passenger workers
without pretending a process-local event emitter is global. Server-Sent Events
may be added only with abort cleanup, heartbeat, reconnection cursor, bounded
connection count, and a cross-process event fanout. EventSource reconnects
automatically, but that convenience does not solve per-browser/per-origin
connection limits or multi-worker broadcast ([MDN SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)).

Mainnet-quality transport requires:

- authoritative command ingress isolated from broadcast;
- idempotent commands;
- ordered sequence IDs and resumable snapshots;
- server-time synchronization;
- backpressure and bounded queues;
- degraded polling fallback;
- command latency histograms and acceptance deadline telemetry;
- no dependency on a client maintaining a socket for settlement.

## Dashboard measures

### Integrity

- conservation delta (must equal zero);
- unclassified surplus;
- state version/sequence gaps;
- fairness verification pass rate;
- simulation-versus-contract differential status.

### Interaction quality

- input-to-local-feedback time;
- command round-trip p50/p95/p99;
- accepted/rejected/unknown lock counts by reason;
- acceptance margin before crash;
- reconnect count and snapshot recovery time;
- render frame p50/p95 and long tasks during lock window.

### Economic behavior

- fresh wagers, rake, PFSS payouts and Vault remainder;
- protected principal and emission buffer growth;
- lottery gross/founder fee/net prize/reset reserve;
- cycle base/high-water progression;
- player distribution and concentration—not individual exploitation scores.

### Player protection

- session duration and explicit breaks;
- voluntary time/stake/loss limits;
- cooling-off/self-exclusion state;
- no near-miss manipulation, loss-disguised-as-win celebration, autoplay, or personalized intensity.

This is a measurable presentation invariant, not soft guidance. If payout is
less than stake, the result is a net loss and cannot receive the same sound,
color, particles, copy, or ordering as a net win. A systematic review covering
51 peer-reviewed studies found near misses associated with increased arousal
and continued-play motivation and found that celebratory presentation of
losses-disguised-as-wins contributes to misclassification and win
overestimation ([systematic review](https://pmc.ncbi.nlm.nih.gov/articles/PMC5663799/)).
A later large online study replicated the LDW win-overestimation effect
([online-sample study](https://pmc.ncbi.nlm.nih.gov/articles/PMC10758393/)).
Plank therefore reports stake, payout, and signed net change adjacent to one
another and derives result styling strictly from signed net—not from payout
being nonzero.

## Responsive composition

- Desktop: play plane center, local controls left/below, roster right, economic rail below, proof drawer overlay.
- Tablet: multiplier and lock remain fixed; secondary panels become tabs.
- 390 px mobile: safety rail, multiplier, lock, stake/target, local receipt; roster/economics/history are drawers. Nothing overlays the lock target.
- Landscape-short: remove decorative copy and lower visual quality before compressing controls.

## Mainnet flip boundary

There is no boolean that turns simulated database credits into money. Mainnet activation requires a separate adapter and build configuration:

- production chain ID and audited immutable contract addresses;
- verified bytecode/config/rules hash;
- wallet transaction construction and explicit signature per economic action;
- chain-defined acceptance/finality and reorg behavior;
- compliance/jurisdiction controls and responsible-play review;
- incident pause/status surface;
- external contract/security audit and economic parameter ratification;
- differential fixtures proving the UI and simulator reproduce deployed contract accounting.

The passkey remains access/session authentication. It never becomes a wallet or custody key.

## Acceptance gates

- n-player concurrent betting/locking with idempotent retries;
- deterministic full replay from event log;
- zero accounting delta over long simulations;
- disconnect at every storyboard transition and exact recovery;
- two-tab/double-click races; stale-version rejection;
- slow, reordered, duplicated, and lost responses;
- screen-reader and keyboard completion of every non-decorative action;
- reduced-motion, forced-colors, 200% zoom, and 390 px tests;
- context-loss and 30-minute visual/economic soak;
- no production RPC write or wallet-sign path reachable from the laboratory;
- explicit external security, contract, economics, accessibility, and legal reviews before live value.
