# Remote movement presentation

Adjacent authenticated peer positions interpolate over100ms. Identity, rather than array slot, retains facing and interpolation state. Duplicate snapshots do not restart the interval. The renderer never extrapolates beyond a saved target. Larger gaps, first admission and expired/replaced peers snap to their received positions. Explicit removal clears immediately. This does not change saved coordinates or authorize combat.

The bridge writes changed interpolated pixels at25ms intervals; native code reads every two frames instead of every fifteen. Source standing tiles remain; this change does not add source walk cycles, replicated gear or physical remote collision.

Four bridge tests verify rejection, expiry, identity reorder, intermediate pixels, duplicate stability and no extrapolation. The browser verifier creates two authenticated local accounts and moves one through the server endpoint. The observer receives intermediate presentation coordinates followed by the exact committed target. The loaded native scene was visually inspected. This verifies one bounded remote step, not a large population or comprehensive motion quality.

## Persistence across many players

The present per-client HTTP-backed WebSocket gateway cannot meet that requirement at large scale. Required next gates are: a fenced owner for each region; ordered authoritative commands; durable command IDs and event/checkpoint recovery; spatial interest subscriptions; bounded delta snapshots; epoch-based region transfers; and shared creature simulation. Region failure must recover committed state without duplicating inventories, rewards or captures. Economic transfers need transactional conservation independently of rendering or socket lifetime.

Define measured population limits per region and for the whole service. Test simultaneous movement and combat, reconnect, worker failure, permission revocation, slow clients, and mixed private/public instances. Increasing a socket cap or interpolating sprites is not evidence of scalable persistence. These architecture gates remain unfinished.
