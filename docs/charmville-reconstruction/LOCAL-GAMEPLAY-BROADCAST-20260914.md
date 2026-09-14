# Local authenticated gameplay signaling

This connects the existing broadcast authority/session/protocol to a real loopback WebSocket server and a browser lifecycle adapter for `createGameplayPeer`. It is development infrastructure, not a production streaming service. The media path remains WebRTC peer-to-peer. A signaling revoke cannot force an uncooperative receiver to stop an already established media connection; production private/allowlisted broadcasting requires a revocable relay/SFU media path.

## Run

Use a disposable local PostgreSQL database with the Charmville migrations, approved test profiles, admission and valid wallet-session tokens. Supply PG connection variables to the process without printing their values. Set `CHARMVILLE_LOCAL_BROADCAST=1`, leave `NODE_ENV` out of production, then run:

```
npx tsx scripts/charmville/serve-broadcast-local.ts
```

Default endpoint: `ws://127.0.0.1:3025/broadcast`. Default browser Origin: `http://localhost:3018`. `CHARMVILLE_BROADCAST_PORT` changes the port; `CHARMVILLE_BROADCAST_ORIGINS` accepts a comma-separated exact list of loopback HTTP(S) origins. The process refuses non-loopback PGHOST and production mode. It never logs session tokens, query parameters or SDP.

## Browser adapter

Import `createGameplayBroadcastClient` from `scripts/charmville/gameplay-broadcast-client.mjs` in a development-only UI. It accepts the endpoint, the current admitted test-session token, and `onTrack`, `onEnded` and `onError` callbacks. After authentication:

- `publish(stream)` accepts one live gameplay video track and at most one audio track, returning the publication ID. The caller chooses and owns the capture source. This does not request camera or microphone access.
- `subscribe(publicationId)` creates a receive-only gameplay peer and delivers incoming tracks through `onTrack`.
- `close()` tears down all its peer connections and signaling. It deliberately leaves caller-owned capture tracks alone; the capture owner must stop those tracks when ending capture.

The adapter authenticates once per connection, serializes requests to the existing protocol, handles SDP/ICE routing, renews owner/viewer leases, and ends peers on authorization loss or disconnect. It supports bounded local previews (16 peers per publication, 8 subscriptions per client). The UI must disclose local preview status and direct-media privacy limits. Do not expose this adapter as accepted public broadcasting.

## Gateway boundaries

- Listens only on `127.0.0.1`, rejects unexpected paths and Origins, never accepts URL tokens.
- Five-second authentication deadline; 40-KiB maximum frame, no compression or binary messages.
- Token bucket of 30 messages/second with a 60-message burst; 32 connections by default.
- 128-KiB buffered-send cutoff; disconnect and lease cleanup.
- Authenticates through `homeActor`, binds the token to the connection's server-resolved profile, and uses `broadcastAuthority` for every authority check.
- Rechecks connected-owner policy revisions every three seconds; ends publication signaling on changed revision. Leases provide an additional bounded lifetime.

No public listing/discovery API, recording storage, production hosting, SFU, TURN deployment or rights-controlled video UI is included here.

## Evidence

`npx tsx --test scripts/charmville/broadcast-gateway.test.ts scripts/charmville/gameplay-broadcast-client.test.ts` exercises real loopback WebSocket connections with a fake authority and fake media peers: identity binding, unauthorized ownership refusal, subscriber routing, offer/answer exchange, revision revocation, Origin rejection, binary rejection, oversize rejection, authentication timeout and cleanup. TypeScript and focused lint pass. These tests prove signaling wiring, not real HD video, live PostgreSQL acceptance, production privacy or performance at scale.
