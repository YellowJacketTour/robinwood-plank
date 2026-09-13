# PlankSpace live gameplay and social theatres

## Product and architecture decision

Live game feed means actual moving gameplay footage and game audio, including animations, camera motion and battles. A location map is not a substitute. One broadcast should serve the profile, floating site player, friends panel and in-world theatres, without requiring a separate player upload for each surface.

The recommendation is to separate media delivery, audience authorization, social synchronization and authoritative gameplay. Start with a WebRTC relay/SFU candidate, benchmark a managed WHIP/WHEP alternative, and keep Media over QUIC behind an interchangeable adapter. This is a proposed architecture, not an implemented streaming service or demonstrated performance breakthrough.

## Capture boundary

Capture inside the native runtime iframe that owns the game canvas. Canvas capture provides a video MediaStream, subject to origin-clean requirements. A tainted canvas or unsupported capture path must report failure. Never automatically fall back to desktop capture. [MDN canvas capture](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream).

Game audio requires a separate connection to the runtime audio graph; canvas capture alone supplies no soundtrack. Microphone, party voice and proximity voice are separate opt-in tracks. DOM wallet controls outside the canvas must never enter the broadcast. Inventory rendered inside the native canvas needs a broadcaster visibility option or a separate broadcast-safe rendering surface.

Public audience policy is separate from starting capture. Provide a local preview, explicit broadcast start, persistent live indicator and immediate stop. Stop ends both tracks and relay publication. Measure mobile encoder overhead against game frame time before selecting capture defaults. Private browsing panels must not be accidentally composited into the broadcast.

## Candidate comparison

| Candidate | Source evidence | Proposed role |
|---|---|---|
| LiveKit / WebRTC SFU | Participant grants, adaptable subscriptions, simulcast/SVC and media export | Interactive viewers, co-streams, moderated theatre voice |
| Cloudflare Stream WHIP/WHEP | Browser ingest and playback through its documented WebRTC beta | Managed one-to-many candidate |
| MediaMTX | Browser WebRTC and Media-over-QUIC publishing documentation | Self-hosted interoperability laboratory |
| Media over QUIC | Relay-capable publish/subscribe over QUIC/WebTransport; active draft | Experimental transport behind the same application interface |

LiveKit's quality adaptation and codec features warrant testing on real target devices. AV1 is not automatically the right default: encoding support, power cost and layered forwarding differ. [LiveKit media options](https://docs.livekit.io/transport/media/advanced/).

Cloudflare documents native browser WHIP ingest and WHEP playback. Its sub-second latency descriptions are provider claims, not Charmville measurements; the feature remains labelled beta. Validate signed access, revocation and failure behavior before selection. [Cloudflare WebRTC](https://developers.cloudflare.com/stream/webrtc-beta/), [browser example](https://developers.cloudflare.com/stream/examples/browser-based-webrtc/).

MediaMTX documents both WebRTC and MoQ browser publishing. This makes it useful for comparing protocols without binding the game's audience policy to one provider. It does not by itself establish a complete social platform. [MediaMTX browser publishing](https://mediamtx.org/docs/publish/web-browsers).

The opened IETF record identifies MOQT draft-21, updated September 8, 2026; earlier search snippets referenced draft-19. Pin implementation and protocol versions in experiments. The protocol is still work in progress. [IETF MOQT record](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/).

A research comparison of QUIC-based media and WebRTC for remote rendering over Wi-Fi and 5G is relevant to experiment design. It does not establish a universal winner for this game or these devices. [Remote-rendering transport comparison](https://arxiv.org/abs/2505.22132).

## Delivery strategy

Benchmark game-only capture against an SFU and a WHIP/WHEP relay. Prefer the SFU if interactive rooms and revocation are simpler; prefer managed broadcasting if passive audience delivery dominates. Stable application operations should be startBroadcast, stopBroadcast, authorizeViewer, subscribe, revokeViewer and getStats. Provider secrets remain server-controlled; viewers receive narrowly scoped capabilities.

Evaluate an HLS/CDN path for larger passive audiences independently of interactive rooms. LiveKit Egress supports recording and HLS/RTMP export; self-hosted Egress requires separate deployment. A second delivery tier must retain the same broadcast identity and policy. [LiveKit Egress](https://docs.livekit.io/transport/media/ingress-egress/egress/).

WebSockets carry chat, presence, moderation and theatre commands. Do not turn them into a growing queue of JPEGs. Video is presentation: neither video frames nor audience messages establish hits, capture results, rewards or inventory changes.

## Browser consensus and peer distribution

A browser mesh does not remove encoding cost, upload constraints, churn or authorization requirements. Peer-assisted public distribution can be benchmarked later with explicit resource limits and relay fallback. Private streams should begin with controlled relays and revocable access.

Use a server-sequenced theatre timeline. Viewers report buffer state and observed delay to support alignment; they do not vote on permissions or economic events. This is a proposed trust boundary. It allows collaborative viewing while keeping custody and access independent of untrusted clients.

## Audience permissions

Public permits anyone to request a viewing session; private permits the owner; allowlist resolves approved handles to authenticated profile IDs. Watching never grants visiting, harvesting, storage, trading or control rights. A media capability must be subscribe-only, scoped to the broadcast and its policy revision.

Every join checks current policy. Revocation must terminate existing unauthorized subscriptions and reject reconnects. Short token lifetime alone is insufficient for an already connected viewer. LiveKit documents token and deployment-specific revocation behavior; verify the actual service configuration rather than assuming hosted and self-hosted semantics match. [LiveKit tokens](https://docs.livekit.io/frontends/reference/tokens-grants/), [participant management](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/).

A theatre cannot widen its source broadcast's audience. Check each viewer against theatre and broadcast policies. Delivered pixels cannot be recalled; measure and state the bound for stopping future delivery. Clips, recordings and thumbnails need explicit retention and audience rules of their own.

## Social viewing experience

Profiles expose accurate Live, Offline, Restricted and Reconnecting states. Viewers can expand, float the player while browsing, join a watch room and send permitted charm reactions. Support muted autoplay and an explicit audio action where required. Hidden cards should reduce or stop subscriptions rather than decode every feed.

An in-world theatre renders a subscribed video on its screen. Crowd voice belongs to the theatre and remains separate from the broadcaster's soundtrack. Multiview raids use opt-in player angles and retain the audience session when switching. Rendering a theatre inside a broadcast must avoid recursive screen-within-screen feedback unless intentionally supported.

Live rooms use bounded playback alignment. Recordings may offer host-controlled pause and seek; those commands never pause the broadcaster's game. Timeline events need sequence numbers, media positions and target times, with late-join resynchronization. Competitive broadcasts may need an optional delay.

Charm gifts must use the existing idempotent custody ledger. Viewing presence is not an asset-minting oracle. Distinguish free reactions from actions that transfer or consume owned charms. Audience counts need a defined deduplication rule and must not silently represent every tab as a person.

## Acceptance gates

1. Capture the native canvas and selected audio only. Exercise resizing, fullscreen, travel, encounters, context loss and stop/restart; verify exclusion of unselected voice and wallet UI.
2. Deliver footage to a second browser/device. Measure visible timestamp delay, game frame time, encoder load, bitrate, dropped frames, audio drift and reconnect.
3. Test anonymous public viewing, private denial, exact allowlists, active revocation, stale-token replay and policy changes during negotiation.
4. Connect profile and one theatre to the same broadcast. Verify mobile audio unlock, offscreen behavior, network adaptation and late joining.
5. Compare transports under controlled delay/loss and increasing audiences. Publish measured capacity with hardware, geography and workload; do not equate local request time with media latency.
6. Add recording, clips, multiview and optional MoQ only after privacy and continuity pass. Preserve the transport adapter so later improvements do not rewrite ownership or the profile UI.

## Repository checkpoint

Viewing-policy parser, storage, migration 130 and owner controls exist. Six focused policy/database tests pass. The location-only profile component was removed. The endpoint reports no active broadcast and exposes no actor location. Actual capture, media relay, video playback, active media revocation and theatre rendering are not implemented by this policy foundation.
