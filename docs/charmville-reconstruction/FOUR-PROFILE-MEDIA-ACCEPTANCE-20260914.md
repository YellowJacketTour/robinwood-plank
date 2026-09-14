# Four-profile media authority acceptance

## Verified in this pass

`scripts/charmville/broadcast-four-profile-pg.test.ts` ran without skips against a generated disposable schema in `charmville_release_menu_20260914`. The schema was dropped after the test. The live `charmville_acceptance_20260913` database was not touched. The test refuses an acceptance database and non-loopback database host.

Four separately created, approved profiles held four independent wallet-session tokens. The real PostgreSQL `homeActor` and `broadcastAuthority` resolved identity and viewing policy. Four real WebSocket connections each published one session and subscribed to the other three: 12 subscriptions and 24 observed offer/answer receipts.

Changing the first owner's policy to private ended that publication for all four clients without ending the other publications. A new private publication rejected another profile. Changing to an allowlist admitted only the listed profile. Revoking the fourth profile's game admission closed its connection and publication while the other three stayed connected. Source capture ownership was conserved: signaling cleanup did not stop caller-owned source tracks.

**Evidence boundary:** PostgreSQL, authentication, WebSocket transport and policy changes were real. Media peer objects were test doubles. This is four-identity signaling acceptance, not four rendered players or four actual video decoders. The previous same-browser self-view proved real video separately (410 presented/408 decoded frames before explicit Stop). These two pieces of evidence must not be combined into a claim that four independent browsers streamed video.

Run with a loopback disposable database URL in `CHARMVILLE_BROADCAST_TEST_DATABASE_URL`:

```
npx tsx --test scripts/charmville/broadcast-four-profile-pg.test.ts
```

## Public broadcasting: next concrete dependency

The current gateway cannot be promoted into privacy-enforced public broadcasting by changing its bind address. It carries signaling; already-established P2P media bypasses it. A production broadcast requires an SFU/relay that actually owns each receiver's media path and can close it independently.

LiveKit's documented distinction matters: Cloud removal also revokes access tokens, whereas self-hosted removal or permission updates do not invalidate existing tokens. A removed self-hosted participant can otherwise attempt to rejoin with an old grant until its TTL expires. Short TTL alone does not satisfy immediate privacy revocation. [LiveKit token and grant documentation](https://docs.livekit.io/frontends/reference/tokens-grants/)

For a controllable self-hosted path, mediasoup fits the existing application's authoritative signaling model: the application creates transports/producers/consumers and propagates closure. It still requires implementation and operations; it is not already integrated. [mediasoup communication model](https://mediasoup.org/documentation/v3/communication-between-client-and-server/)

### Required implementation order

1. Create a separately deployed media process with server-owned producer and consumer identities. Keep viewer streams receive-only. Check current PostgreSQL session/admission/policy on creation and reconnect.
2. Wire committed policy revisions to a durable revocation command. Deny new subscriptions immediately; close the actual SFU consumers for existing viewers, and record the relay acknowledgement. A disconnected control plane must fail closed for the publication instead of continuing indefinitely.
3. Test a deliberately uncooperative receiver: ignore application close messages, retain old credentials and retry after private/allowlist changes. Measure received bytes/decoded frames after the relay's revocation deadline. Repeat after process restart and reconnection. This is the missing privacy acceptance test.
4. Deploy a dedicated TLS/WSS endpoint and media-capable networking, including a tested TURN/TLS route for restrictive networks. An ordinary Next.js HTTP reverse proxy is not sufficient for WebRTC UDP media. [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/) and [media ports/firewall reference](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
5. Only then expose profile discovery and theatre UI, with explicit sharing state, Stop, allowlist management, independently tested viewers and resource ceilings. Recording/retention requires its own explicit controls.

No public relay, hosted-room credential, production CSP change or broadcast deployment was enabled in this pass. The safe improvement delivered here is the four-profile PostgreSQL/socket acceptance test and stage-specific local preview errors; the next media service must satisfy the above tests before a public privacy claim is made.
