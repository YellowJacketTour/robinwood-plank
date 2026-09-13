# Shared-world research and implementation checkpoint — 2026-09-12

The ambition is a single persistent identity and economy across action combat, companion battles, farms and public regions. Current implementation does not establish a scalable complete MMO. The native reference map and local combat remain substantial integration boundaries.

## Evidence informing the next architecture

- Riot explains simulation divergence, hit registration and latency tradeoffs: https://www.riotgames.com/en/news/peeking-valorants-netcode
- Riot's server performance account illustrates measured profiling and capacity budgets, rather than treating a high tick rate as sufficient: https://www.riotgames.com/en/news/valorants-128-tick-servers
- Entity interpolation separates remote presentation from authoritative updates: https://www.gabrielgambetta.com/entity-interpolation.html
- Photon documents interest-area membership for replication: https://doc.photonengine.com/fusion-core/v3/manual/interest-area

These are source-informed directions, not evidence that Charmville has implemented their complete systems. No claim of a novel algorithm or superior measured capacity is justified yet.

## Implemented this pass

Region-map projection now checks account, admitted region, finite coordinates, epoch, actor version and input sequence before replacing its state. Older movement responses cannot rewind its actor marker. Equal actor versions remain acceptable because peers may move while this actor stands still. Two targeted regression tests cover ordering, travel/account boundaries and malformed positions.

## Outstanding consistency boundaries

Peer snapshots do not yet have their own region-wide tick/version. Actor version cannot order two peer updates for an idle actor. A server-issued region snapshot tick is needed before claiming stale peer updates are solved. Native peer messages and movement reconciliation are separate paths; this patch only guards minimap projection. Cross-region handoff, real multi-client combat, visible follower animations and camera continuity still need live verification.

## Next connected milestone

Introduce a region snapshot envelope carrying region epoch, simulation tick, geometry revision and interest-set revision; share validation across native actors, companion rendering and minimap. Benchmark two real clients under delayed/duplicated snapshots and reconnects before increasing load. Then add spatial interest filtering with explicit enter/leave records and interpolation history. Keep reward, capture and market custody authoritative and outside speculative presentation. Browser mesh experiments must be isolated from these authoritative mutations.

Acceptance must include visible movement and combat, not only menu navigation: both players agree on region and participants, travel cannot resurrect old entities, companion roster and world sprites agree, and each reward or capture is settled once.

## Follow-up: shared display gate and live session

Native nearby-player messages now originate from the same accepted projection as the minimap. Partial actor acknowledgments preserve peers within the same epoch; explicit empty sets and disconnects clear them. Socket synchronization is gated too. Companion-specific state is still a separate path and is not covered by this change.

Validation: targeted ESLint, TypeScript and two region-ordering tests passed. Same existing browser tab 15 was used, with the synthetic local profile. Entered the native world, advanced introduction and reached the visible soil-preparation prompt. A Right key was issued, but actual movement was not established from these screenshots. No second player or shared combat was verified. No wallets or signatures were used.
