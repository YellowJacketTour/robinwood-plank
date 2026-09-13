# Movement continuity: diagnosis and replacement contract

Research date: 2026-09-13. Status: architectural failure reproduced; replacement not implemented or live-accepted.

### Implementation follow-up

The independent 30-second arrival reset was identified and fixed in `world.tsx`: background renewal retains admission without incrementing the native arrival request. Five executable regression cases now cover real callback/timer behavior, including explicit travel and revoked permission.

`lib/charmville/input-reconciliation.ts` now implements bounded pending input, acknowledgment replay, snapshot revision ordering, explicit newer-epoch reset and defensive state/input copies. Six tests include 36,000 simulated ticks with 250 ms delayed acknowledgments, authoritative correction, out-of-order snapshots, overflow and epoch changes. These use a deliberately simple reducer: they prove bookkeeping, not ZQuest collision or movement parity. It is not connected to native Hero or the server. Do not mark the movement replacement complete on this evidence.

The next integration gate remains a shared source-compatible locomotion reducer and authoritative input receiver. Preserve snapshot revision ordering independently of the input acknowledgment: two snapshots may acknowledge the same input while carrying different world impulses.

Receiver follow-up: `input-authority.ts` now provides an isolated region-worker input receiver. It validates contiguous sequences, skips committed retransmissions, caps server-clock tick credit, rejects wrong epochs and stages a whole batch before committing state. Four tests cover those boundaries and pair it with the predictor over 6,000 synthetic ticks, batching every ten ticks with acknowledgments delayed 25 ticks. TypeScript and focused lint pass. The caller must authenticate admission and supply a trusted monotonic clock; this module is not an endpoint, does not persist state, and is not wired into the native runtime. Collision and source movement parity remain unproven. Integration must include failover/durability and approved geometry before replacing the existing authority.

## Finding

The current movement bridge is a serial position-validation queue around an independently running native simulation. It is not input prediction with server reconciliation. A valid player can outrun the acknowledgment queue and be corrected backward even without packet loss. This is a demonstrated defect, not yet proof that it is the only cause of the user's current session glitch.

The actual `createNativeMovementClient` was exercised with adjacent positions on an unobstructed rectangular path, one cell every 100 ms and a synthetic 250 ms response per committed request. Initial placement succeeded. At 11,789 ms it emitted `nonadjacent-observation`, correcting (24,104) to (64,104): a 40-pixel displacement. There had been 45 acknowledged steps and 112 observations by termination. The subsequent correction is not a separate reproduction: this harness records correction commands but does not simulate native repositioning after the first failure.

Reproduce from repository root: `npx tsx work/movement-backlog-repro.ts`. Evidence: `work/movement-backlog-result.json`. This imports the actual client, but mocks the server and geometry; it does not establish production RTT or collision correctness. No live game state or account was changed.

## Where continuity breaks

| Mechanism | Local evidence | Consequence / confidence |
|---|---|---|
| Serial request acknowledgment | `lib/charmville/native-movement-client.ts`, drain awaits process; process awaits request | At 250 ms, capacity is at most four steps/second while native walking generates about ten. Demonstrated backlog failure. |
| Silent queue truncation | Same file clears pending at 64 entries | Required adjacent path disappears; next retained position triggers nonadjacent rejection. Increasing capacity merely postpones overload. |
| Old position applied to current simulation | `correct()` sends saved cell times eight; Homestead assigns Hero X/Y | No unacknowledged input replay. A valid past state can produce a visible present-time jump. |
| Different movement models | Native legacy four-way pixel alignment versus server 8-pixel adjacent-cell timing | Near-boundary reversals and perpendicular alignment do not have uniform whole-cell timing. Model mismatch remains even with fast transport. See NATIVE-WALK-CADENCE.md. |
| Transactional movement hot path | `lib/charmville/native-actor.ts` locks presence and actor; can wait inside transaction | DB/network latency participates in locomotion throughput; potential contention amplifier, not measured here. |
| Finite observer history | Native position ring retains 64 frames; observer cannot recover overwritten frames | Browser stalls can remove genuine path history. Inventing intermediate cells would not prove collision legality. |
| Session recovery | Failed recovery clears actor; next observation performs spawn placement | Another route to relocation. The retained browser diagnostic was an arrival/placement event, not a proven queue-overflow event. |
| Unsupported states | Bridge excludes airborne and some maps | Landing or resuming needs explicit state transitions, not incidental catch-up. Exact live incidence unresolved. |

## What established engineering supports

Gambetta explains why applying old server positions directly causes jumps: authoritative snapshots describe already-processed inputs, while the client is further ahead. Acknowledge an input sequence, restore the corresponding state, and replay only later inputs. This requires matching simulation behavior. [Client-side prediction and reconciliation](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html).

Fiedler separates fixed simulation steps from display refresh and explains why variable time steps alter collision behavior and why insufficient processing headroom accumulates backlog. Our network queue is a separate overload mechanism; his article does not diagnose this repository. [Fix Your Timestep](https://www.gafferongames.com/post/fix_your_timestep/).

Riot compares original simulation with recorded playback and logs structured state to locate the first divergence. Adopt a bounded movement-state trace, rather than visually guessing which late correction caused the original disagreement. [Determinism: Fixing Divergences](https://www.riotgames.com/en/news/determinism-league-legends-fixing-divergences).

Browser rendering callbacks can pause in background tabs or hidden iframes. Treat resume as an explicit resynchronization event; do not turn elapsed wall time into unlimited movement credit. [MDN requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame).

Transport features do not establish game authority or movement parity. WebSocket requires application-level queue bounds; WebTransport offers additional stream/datagram capabilities but cannot repair a mismatched simulator. Retain a supported transport until measured needs justify replacement. [MDN WebSockets API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/index.html).

## Proposed solution: one movement model, multiple views

1. **Shared fixed-tick locomotion kernel.** Inputs, actor position, facing, collision shape, movement mode, terrain and explicit impulses determine the next state. Begin with the active native 60 Hz four-way rules, including turn alignment; retain subcell precision. Pin the geometry and rules version. Port or expose the relevant native rules, then compare frame traces. A new generic TypeScript mover is not automatically source-compatible.
2. **Numbered input stream.** Send bounded input batches without awaiting each previous cell's round trip. Each command has session, region epoch, input sequence and bounded duration/button state. Server validates identity, elapsed-time budget, geometry and sequence. Client timestamps are not authority and idle time cannot accumulate unlimited credit.
3. **Prediction and replay.** Local play immediately uses that same kernel. Server snapshots carry tick and last processed input sequence. Restore the authoritative state and replay outstanding inputs. Rendering can ease a small residual offset; collision remains the reconciled state. Replay never duplicates inventory changes, loot, sounds or attacks: effects need stable event IDs and authoritative commits.
4. **Explicit discontinuities.** Spawn, death, teleport, border transfer, reconnect and pause/resume have named transitions and epochs. Exactly one owner may place the actor. Ordinary snapshots must not re-run arrival scripts. Reject old-epoch messages atomically.
5. **World-space coordinates.** Simulation positions belong to region/chunk coordinates, independent of camera offsets. Crops, drops, followers and collisions use the same transform. Scrolling changes the camera, not object identity. Source screen scripts need explicit adapters; camera continuity alone cannot turn a screen-based engine into a seamless world.
6. **Stable follower simulation.** Companions consume the owner's continuous path and formation commands using stable entity IDs. Facing changes select animation; they must not recreate entities or clear trail history. Reset paths only on an explicit discontinuity. Remote actors interpolate snapshots; local actors use prediction.
7. **Authority separated from storage.** A region worker advances actors at fixed ticks in memory; movement is not a database transaction per pixel/cell. Checkpoints and a recovery log persist location; transactional economy remains separately authoritative and idempotent. Worker ownership, failover epoch and acknowledged durability policy must be specified before claiming seamless persistence at scale.
8. **Bounded overload behavior.** Limit pending input duration, snapshot backlog and per-frame work. Track queue age, not only length. On unrecoverable gaps show a reconnect state and perform one explicit authoritative resume. Never silently discard movement then repeatedly treat the player as invalid.

## Build order and acceptance

First add bounded diagnostics for queue high-water/oldest age, request duration, observer gaps, client lifecycle resets and correction cause. Capture the same visible session through its first glitch. Keep credentials, account payloads and wallet data out of traces.

Next extract golden native traces: straight walking, near-boundary reverse, every perpendicular turn, wall contact, corners, slowed ground, attack movement, knockback, landing, border travel. Implement the shared kernel only against those traces. Run client/server differential replay and locate the first divergent tick.

Then add input batches, acknowledgments and replay behind a feature flag. Preserve the current transport as a rollback option during migration; do not mix two position writers. Switch the live adapter only after parity and security cases pass. A source engine that cannot consume the shared solver requires an explicit engine integration, not another observer timing patch.

Acceptance includes 60-second and 10-minute movement loops; 0/50/150/250 ms delay and jitter; delayed/lost responses; duplicate commands; browser pause/resume; reconnect; every direction; action interruption; six followers; borders; 30/60/120 Hz rendering. Require bounded queue age, no unexplained hard placements in unobstructed deterministic cases, no extra movement from forged timing, stable collisions and no duplicate economic effects. Check the actual retained browser and traces after integration. Network uncertainty can still require corrections; zero latency and unlimited player scale are not defensible promises.

## Decision

Do not raise speed tolerance, enlarge the queue, remove server validation, or add a second smoother as the main fix. Preserve source feel by sharing its movement rules, and preserve multiplayer trust by reconciling inputs. The reproduction and plan are complete; production integration and live acceptance remain outstanding.
