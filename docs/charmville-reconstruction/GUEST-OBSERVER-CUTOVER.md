# Guest and observer cutover

Audit date: 2026-09-13. This is an existing-code audit, not a deployment claim. Read repository AGENTS, README, ARCHITECTURE and CONTRIBUTING before tracing these routes. No implementation files were changed by this audit.

## First playable blocker

There are two separate cutovers. The authenticated account world still embeds and messages the development runtime at `http://localhost:3021`; the rebuilt world being tested on port 3024 is a standalone local adventure. A working local renderer therefore does not prove authenticated shared-world admission. Separately, actual remote profile footage has no publication transport or profile viewer yet.

The smallest safe first implementation is one validated runtime endpoint shared by the iframe URL and every incoming/outgoing native bridge origin. Preserve exact origin and iframe-source validation. Do not merely change the iframe URL, allow wildcard origins, or remove development gates. Before selecting the rebuilt renderer, prove its admission, initial placement, resources, companions and encounter bridges match the account world. This fixes configuration divergence; it does not deploy multiplayer or broadcasting.

## Operational boundaries and exact paths

| Surface | Existing implementation | Limit or missing connection |
| --- | --- | --- |
| Account runtime | `app/charmville/world/page.tsx` enables local runtime only in development. `app/charmville/world/world.tsx` embeds `http://localhost:3021/charmville/tutorial/?runtime=movement-history-1` and pins native message origins to port 3021. | Production displays a native-hosting placeholder. Root independently verified rebuilt port 3024 is bound to `127.0.0.1` and shows Local adventure. It is not a remotely reachable deployment. |
| Friend visit | `world.tsx` exposes Go home, Public meadow and Visit friend. `lib/charmville/world-entry-client.ts` retries one transient failed entry with the same revision. `app/api/charmville/world/presence/route.ts` and `lib/charmville/world-presence.ts` authenticate entry and enforce visit grants. | Presence uses `home:<id>` or `public:meadow`, a 90-second lease, 30-second UI refresh and at most 64 returned peers. This is not a complete global place/floor/instance model or capacity reservation service. |
| Home permissions | `lib/charmville/home-access-store.ts`, `app/api/charmville/[handle]/access/route.ts`, `app/charmville/start/home-permissions.tsx` implement owner-managed visit/help/harvest/build/storage rights, expiry, revision and storage-container restrictions. | Visit alone grants no harvesting, building or storage access. Grant checks occur within action transactions. Admission and media permission must remain separate. |
| Encounter observer | `lib/charmville/native-encounter-projection.ts`, `app/charmville/world/encounter-panel.tsx` and `scripts/charmville/world-encounter.js` project constrained encounter state and committed effects. | This is state observation by an admitted participant, not audiovisual streaming. `app/charmville/world/capture-stream.ts` carries creature-capture receipts, not camera footage. |
| Viewing policy | `lib/charmville/spectator-policy.ts`, `lib/charmville/spectator-store.ts` and `app/api/charmville/spectate/[handle]/route.ts` implement public/private/allowlist metadata access, owner-only revisioned edits and private/no-store responses. | `spectatorView` returns `online:false` and `actor:null` even for permitted viewers. No publication lookup, subscriber token or transport exists here. |
| Owner settings | `app/charmville/world/spectator-settings.tsx` edits viewing policy and explicitly says broadcasting is not connected. Migration `deploy/inmotion/postgres/migrations/142_charmville_spectator_settings.sql` stores policy. | There is no publish toggle, publication epoch or publication lease. After a stale-revision conflict the UI does not refetch the revision; reopening is currently needed. |
| Local footage source | `scripts/charmville/gameplay-video.mjs` offers an explicit local preview using `scripts/charmville/gameplay-capture.mjs`. It captures the game canvas and optionally branches the running engine audio node, without microphone or desktop capture. | Root live-verified local video **and game audio** preview and stopping during this work. This proves a local source only. HTML party/Charmdex/HUD overlays outside the canvas are not part of that footage. |
| Profile page | `app/(plankspace)/u/[handle]/page.tsx` reexports `integrations/plankspace-app/app/u/[handle]/page.tsx`, which uses saved featured-video links through `profile-video-player.tsx` and a separate MiniGame. | No Charmville live-view component or spectate-route consumer is wired into this profile page. |

The runtime server, `scripts/charmville/serve-reference-runtime.mjs`, currently constrains connections with `connect-src 'self' ws://localhost:3022` and uses COOP/COEP isolation. Remote signaling/media endpoints require an explicit compatible hosting and policy change. `lib/charmville/local-playtest-client.ts` deliberately scopes local test identities to development, loopback and game routes; preserve those restrictions.

## Privacy and lifecycle requirements

Public audience policy is not consent to start a broadcast. The current default-public settings row must never automatically trigger capture. Owner identity must come from the authenticated server session, not a client-supplied handle.

Current policy enforcement denies later metadata reads; it cannot revoke active video because no active subscriber transport exists. Future policy changes need publication-epoch invalidation, active subscriber termination, and fresh checks on subscribe, reconnect and renewal. A test named immediate read denial is not evidence of active-media revocation. Previously received pixels cannot be recalled.

Home visit permission, encounter participation and media viewing are independent capabilities. Whether a visitor may broadcast from a private owner's home needs an explicit location policy before shipping. Media viewers must receive no inventory mutation or movement authority.

Local capture already stops owned tracks on close, page lifecycle termination, context loss, arrival restart and canvas replacement/removal. Optional audio branches must disconnect only their own output and leave local speakers intact. A missing engine audio output permits silent video; a supplied but invalid/suspended output fails cleanly. Keep those ownership rules through transport integration.

## Ordered implementation dependencies

1. **Unify the account/runtime endpoint.** Centralize URL and message origin, then prove account arrival and persistence on the rebuilt renderer without a duplicate canvas, wrong spawn or local-state substitution.
2. **Define server-owned publication identity.** Add explicit start/stop, owner authentication, publication ID/epoch and expiry. Store control state in the existing PostgreSQL architecture. No client-controlled owner IDs or automatic capture.
3. **Connect media transport.** Add authenticated signaling and a selected relay/SFU deployment, with explicit secure-origin, CSP and cross-origin-isolation compatibility. Measure canvas-plus-engine-audio delivery between separate devices before any scale claim.
4. **Enforce active revocation.** Apply audience and location permission changes to connected viewers and token renewal. Stop publication on expired ownership/lease; reject stale epochs.
5. **Wire the profile viewer.** Show actual footage, with honest offline, restricted, reconnecting and unsupported states. Do not replace offline video with invented activity or encounter-state animation.
6. **Separate Watch, Visit, Join and Return.** Watching needs media permission; visiting needs a home grant; joining needs world admission and capacity. A failed destination admission must leave the player at the valid origin with progression intact.
7. **Add theatre fan-out and measured capacity.** Reuse a publication rather than recursively capturing players watching players. Bound subscriptions, bandwidth and interest sets; publish observed device/network capacities rather than claiming unbounded players.

## Executable acceptance plan

Existing focused suites below were identified but **not executed by this documentation audit**. Database suites require an already configured isolated localhost `CHARMVILLE_TEST_DATABASE_URL`; absent database configuration may skip integration coverage and is not a pass. Never point these checks at production.

```powershell
node --test scripts/charmville/gameplay-capture.test.mjs scripts/charmville/gameplay-video.test.mjs
npx tsx --test test/market/charmville-spectator-policy.test.ts test/market/charmville-world-presence.test.ts
npx tsx --test test/market/charmville-spectator-store.test.ts test/market/charmville-home-access.test.ts test/market/charmville-world-presence.test.ts
```

| ID | Action and required observation | Current evidence boundary |
| --- | --- | --- |
| GO-01 | Owner grants only visit; guest enters and sees the same home. Guest harvest/build/storage attempts fail without changing balances or home state. | Existing admission and transactional rights code; run isolated integration tests. |
| GO-02 | Revoke an active guest, then immediately attempt an action and refresh presence. Action is denied and peers exclude the revoked guest without relying on the guest's next UI poll. | Existing transaction and presence checks; verify with two approved test identities. |
| GO-03 | Lose an arrival response and resend the exact entry revision. The accepted retry returns the same arrival epoch/lease; expired or incompatible replay fails. | Existing bounded retry and idempotent admission code. |
| GO-04 | Open the authenticated account world against the selected rebuilt endpoint, move, change area, reload and return. Identity, inventory, placement and companions remain consistent; unrelated window messages are rejected. | Blocked until runtime endpoint/bridge cutover is proven. |
| GO-05 | Query viewing policy anonymously, as allowed viewer and as unrelated viewer; change to private and retry. Check owner-only writes, stale revision conflict and no-store responses. | Existing metadata policy only, not live-stream revocation. |
| GO-06 | Start local preview, hear game audio, close it; repeat through arrival/canvas replacement and context loss. Owned tracks stop and normal game sound remains. | Root observed local preview/audio/stop. Additional failure cases have focused suites. |
| GO-07 | On two separate devices, start an explicit publication and watch the actual moving canvas with game sound on the profile. Record first-frame time, ongoing latency and reconnect behavior. | Blocked: publication, remote transport and profile player are absent. |
| GO-08 | While a viewer is watching, make the audience private or revoke its allowlist entry. Active delivery stops; old credentials and reconnect cannot resume it. | Blocked: active transport revocation is absent. |
| GO-09 | From Watch, request Visit/Join with and without the required grants and available capacity; then Return. Failed entry preserves origin; successful travel preserves progression. | Visit exists; coordinated Watch-to-Join, capacity and Return transactions remain to build. |
| GO-10 | Watch one publication in a theatre with multiple viewers, including policy changes and disconnects. Verify bounded fan-out and no recapture loop. | Not implemented; no deployed scale claim. |

Existing `scripts/charmville/verify-shared-battle-scene.mjs` and `verify-spectator-capture.mjs` test encounter observation/creature capture, not GO-07 audiovisual profile streaming. They must not be reported as evidence that live broadcasting is complete.

## Runtime bridge configuration implemented

Account iframe navigation and all five native bridge modules now import one native-runtime.ts configuration. The default stays3021. NEXT_PUBLIC_CHARMVILLE_RUNTIME=rebuilt selects3024 for every origin check and outbound message together; arbitrary origins are not accepted. Next public configuration is fixed at build time (or requires restarting development), not a per-player query parameter. TypeScript passed and a scoped search found no remaining hardcoded3021 bridge literals outside the configuration module. This change does not enable a production runtime or certify3024 account admission; keep the default until the coordinated cutover scenarios pass.

## Rebuilt tutorial compatibility follow-up

Read-only HTTP checks on both ports at 2026-09-13 11:35 UTC returned `302` for `/charmville/tutorial/`, with **the same legacy** `/quests/charmville/homestead/r01/Homestead.qst` target, dmap 4, screen 63 and starter equipment. Neither redirect selected `/homestead-region/`. `scripts/charmville/adventure-entry.mjs:homesteadUrl()` chooses that legacy path without considering the rebuilt runtime. `serve-reference-runtime.mjs` selects rebuilt engine files separately; switching the account origin therefore does not select the joined world quest. The incoming `runtime=movement-history-1` query is not propagated by this redirect.

The shared wrapper mounts `tutorial-bridge.js`, `position-observer.js`, `account-peers.js` and `resource-bridge.js` through `runtime-shell.mjs`. Their virtual files consistently use `FS.cwd()/Files/Homestead/charmville/`; native `Homestead.zs` uses its quest-relative `/charmville/` alias. The current source writes 12-field position observations including region dimensions and map. `position-observer.js` accepts both old nine-field and current twelve-field observations, converts region pixels to source-screen-local pixels, and retains region metadata. This is a compatibility adapter, not full-region account authorization.

Embedded startup deliberately waits for a native acknowledged correction before revealing arrival. A run-generation change creates a fresh session ID and clears correction sequence state; correction messages must match the parent, approved host origin and current session ID. Standalone play bypasses this admission gate by design. Tutorial completion is presentation state from the authenticated parent; these files contain no account credentials and grant no custody rights.

**Exact remaining restriction:** the browser correction receiver, peer projection and native correction validator only accept dmap 4 screens 62/63 and bounded screen-local placement. The native correction code adds the loaded region offset once, after any required warp. Server resource actions still refer to `geometry/native-adventure-d4-s63.json`, three beds and the current home/public region epoch. Thus the source supports converting placements inside the admitted rooms; it does not establish admission, collision geometry or resource authority for every screen of the joined world.

The smallest next safe change is an explicit, allowlisted rebuilt tutorial quest selection that remains behind the existing build setting, followed by GO-04 against both admitted rooms. Do not change the shared legacy redirect unconditionally or extend screen allowlists without corresponding server geometry and travel validation. To enable the *entire* joined region, define and validate each admitted screen's geometry/region mapping, peer coordinates, resource anchors and legal border transitions first. Keep the default runtime unchanged until the coordinated account checks pass.

No browser session, account mutation, port change or deployment was performed during this follow-up. The HTTP redirect checks and source trace do **not** certify WASM file-alias behavior, compiled quest freshness, full-region admission or successful account play on port 3024; those remain explicit live acceptance requirements.

Follow-up implementation: rebuilt native-runtime.ts URL now explicitly selects homestead-region instead of the tutorial redirect that still selects legacy homestead. Default remains unchanged. TypeScript passed after this adjustment. Do not enable the rebuilt account option as a completed migration: account movement/correction/peer coordinate coverage remains restricted and needs expansion plus admission validation.

## Broadcast transport implementation — fe3a277

Added bounded server broadcast-session lifecycle and browser gameplay-peer WebRTC module. Four server authorization/revision/expiry tests and four browser-peer lifecycle tests passed. Publisher connections are send-only; viewers acquire no camera/microphone and closing one peer preserves the publisher-owned shared source. ICE candidates are bounded and queued until remote description; late offers after closure are suppressed. Protocol reference: https://www.w3.org/TR/webrtc/.

These modules are not yet connected to an authenticated signaling gateway or profile player. Server policy revocation must stop relay/SFU delivery; direct peer-to-peer signaling revocation alone cannot enforce cessation of already-flowing media. Actual two-device footage, reconnect, TURN traversal and active privacy revocation remain unverified. No remote broadcast has been enabled.
