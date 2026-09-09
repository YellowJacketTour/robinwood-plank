# Native movement connected to account state

Verified locally on 2026-09-09. `scripts/charmville/verify-native-account-movement.mjs` drove seven native 8px steps and read the authenticated actor endpoint. The same profile moved from cell (2,9), sequence/version 0, to (9,9), sequence/version 7 in public:meadow. The geometry was `native-adventure-d4-s63`, revision `85ddb0eb1fc8d404baf5268e05e3f1721b7bb320d8efa7e50fca1d687dd34468`, with a 2x2-cell footprint. The run required one initial spawn placement and no rejection corrections. Evidence is in `work/native-account-movement/result.json` and `movement.png`.

Focused PostgreSQL actor checks cover two identities, replay, reconnect, lease expiry and travel invalidation. Native movement client checks cover bounded 20ms timing jitter. Relevant tests: `test/market/charmville-native-actor.test.ts` and `test/market/charmville-native-movement-client.test.ts`. The endpoint is `app/api/charmville/world/actor/route.ts`.

This is locally connected account movement on the stated authored geometry. It does not establish shared combat, resource settlement, rewards, native map warps, arbitrary-map geometry or production multiplayer performance. Travel invalidation tested in the service is not a playable native border transition. A movement acknowledgment is not a harvest receipt. The next gate is an independently authorized timed world action with atomic settlement and shared presentation.

## Two-account native peer projection

The expanded `verify-native-account-movement.mjs` browser test now verifies two authenticated accounts. Bob's stored actor appears in Alice's native world; the projected file uses mode 1 and the stored coordinates, and the resulting screenshot was inspected. The actor GET returns at most 16 peers filtered to the same geometry and region, with approved active access. This closes a bounded account-to-native peer visibility gap.

Presentation currently polls every two seconds and uses a fixed standing pose. It does not interpolate movement or animate other players, and peers do not provide hit collisions or shared combat. Bars remain locally connected rather than production multiplayer. The next blocking integration is timed authoritative action settlement: action start/contact/cancel, permission recheck, resource revision, atomic input/output receipt, replay recovery and shared committed-resource presentation. Peer visibility alone cannot authorize resource rewards.
