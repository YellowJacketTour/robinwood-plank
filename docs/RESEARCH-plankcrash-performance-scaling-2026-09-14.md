# PlankCrash public test: performance & scaling — best-in-class options (2026-09-14)

Scope: the hosted invite table on plank.love (Astra's arcade + anvil chain + keeper +
invite gateway) must be perfectly playable on PC and phones for public testing.
This is a research synthesis against the failures we actually measured this week,
ranked by what removes the most risk per hour of work. Every claim below is either
measured on plank.love or sourced (links at the end).

## 0. What actually broke (measured), and the class of each failure

| # | Symptom | Root cause (measured) | Class |
|---|---|---|---|
| 1 | Whole site 503 "queue full", Passenger "could not be started", SSH sessions reset | `node: fork: retry: Resource temporarily unavailable` — the shared CloudLinux account hit its NPROC/EP ceiling. 31 procs / 2.3 GB RSS: market-mesh 501 MB (spawns a child per tick), opensea-stream 323 MB, akasha-hose 224 MB, anvil 811 MB, next-server, realtime, relayer, koth ×2, table preview + gateway | **Host capacity** |
| 2 | Table 500 for 10+ min, anvil refusing to boot | Two deploys restarted the table within a minute; anvil's in-place state dump was torn mid-write; anvil rejects a truncated `--state` file forever | **Deploy collision / non-atomic state** |
| 3 | Phone ran yesterday's CSS/JS for hours after a deploy ("sometimes fixed") | Cloudflare hands `/arcade/*` a 4 h browser TTL; `no-cache` from origin was rewritten; ES-module graph half-stale | **Cache invalidation** |
| 4 | Phone "extremely laggy", freeze mid-flight | Desktop render tier on a phone (1.5× through bloom + god-rays + lens-flare + PCFSoft shadows, second WebGL renderer for the lottery, 240 Hz/16-iter physics) and the lottery machine built on the main thread mid-flight | **Mobile GPU/CPU budget** |
| 5 | Lottery card text squeezed off-screen, "Back to flight" hidden | Generic `.lottery-theatre canvas{width:100%;height:100%}` outranked the prize-tray thumbnail rule; canvas intrinsic size blocked flex shrink on iOS | **CSS specificity / iOS layout** |
| 6 | Repeat skipped every third round → "no scorecard" | Gate needed 8 s review hold + ≥8 s betting left inside a ~20 s window | **Client timing logic** |
| 7 | Returning guest at Ξ 0.0000 after a rebuild | Re-fund only ran on `join`, not on the session read the tab actually makes | **Gateway logic** |

Items 2–7 are fixed and verified on plank.love. Item 1 is structural and is the
subject of §1.

## 1. Host capacity — get the table off the shared account

**Finding.** CloudLinux LVE limits NPROC (total processes in the LVE) and EP
(concurrent entry processes into the web server). Once NPROC is reached "no new
process can be created" — `fork: retry: Resource temporarily unavailable` — and
the web server answers 500/503 ("queue full" is Passenger's request queue backing
up because it cannot spawn the app). SSH sessions are forked processes too, which
is why GitHub's runners were reset at the door in the same window. Every
background node service on the account (mesh, hose, stream, relayer, koth, the
table) counts toward the same ceiling. [CL-EP-NPROC] [CL-FORK] [LSWS-CL]

**Options, ranked.**

| Option | What it fixes | Cost | Effort | Verdict |
|---|---|---|---|---|
| **A. Move the table (anvil + keeper + gateway) to a €4–6/mo VPS** (Hetzner CX22 2 vCPU/4 GB ≈ €4.35; Fly shared-cpu-1x 1 GB ≈ $5.70) and reach it from plank.love via the existing Next rewrites pointed at the VPS, or via a **Cloudflare Tunnel** (free, WebSockets by default, outbound-only) | Removes ~1.1 GB RSS and 3 long-lived processes + their cron forks from the shared account; the table no longer restarts when the site deploys; a real process manager (systemd/PM2) replaces cron+flock; SSH never contends with Passenger | ~€5/mo | 0.5–1 day | **Do this first.** Biggest risk removed, cheapest |
| B. Ask InMotion to raise LVE NPROC/EP for the account | Buys headroom, nothing else | $0–? | 1 email | Do in parallel; ask for the actual numbers (`lveinfo`/cPanel "Resource Usage" shows the current ceiling and when it was hit) |
| C. Cap market-mesh fan-out (worker slots / concurrent `mesh-tick` children) | Removes the burst that tipped the account | $0 | hours | Worth doing regardless; the mesh is the only component that forks per tick |
| D. Move the whole site to a VPS/PaaS with a real process model (PM2/systemd, blue-green) | Ends the class entirely (Passenger open-source has no rolling restart — that is Enterprise-only) | $10–40/mo | days | Right long-term answer; not required for the test |

**Recommended shape (A):** one small VPS runs `anvil` (systemd unit, `Restart=always`),
`arcade-preview.mjs` (keeper) and `invite-gateway.mjs`, fronted by `cloudflared`
(free) so plank.love's `/table`, `/api/invite/*` rewrites target
`https://table.plank.love` (tunnel hostname) instead of `127.0.0.1:8766`. The
gateway already parameterises RPC/chain/manifest, so nothing in it changes. Chain
state lives on the VPS disk with the atomic-dump fix below. [FLY] [HETZNER] [CFT]

## 2. anvil: memory and state durability

**Findings.** anvil's memory grows with retained blocks/states; `--transaction-block-keeper N`
bounds the blocks kept in memory, `--prune-history [N]` keeps at most N states in
memory (and disables state persistence, so it is NOT for us), `--state-interval S`
dumps the whole state every S seconds, and `--memory-limit` is per-EVM-execution,
not process RSS. Long-running anvil RSS growth and multi-GB disk growth are open
upstream issues. [ANVIL-REF] [ANVIL-6017] [ANVIL-8392] [ANVIL-4252]

**Applied now:** `--transaction-block-keeper 6000` (10 min of 0.1 s blocks; was 50 min),
`--state-interval 60`, no `--preserve-historical-states`, torn-state detection with
fallback to the last healthy copy then the release seed.

**Best-in-class next:**
- **Atomic dumps.** anvil writes `--state` in place. Run it with `--state` pointing at
  a scratch file and let the supervisor copy `scratch → state.json.tmp → rename` on a
  timer, or stop anvil with SIGTERM and wait for its exit dump before any restart
  (deploy-table now kills preview/gateway first, then anvil, then waits). Never
  restart twice within one `--state-interval`.
- **Slower blocks off the hot path.** 0.1 s blocks are only there so bets land fast;
  `--mixed-mining` already mines on submit. 0.5 s interval blocks cut state churn 5×
  with no visible change to the arcade (liftoff is clock-anchored, not block-anchored).
- **Alternative to self-hosting a chain:** Tenderly Virtual TestNets (shareable
  explorer, unlimited faucet, RPC + WebSocket, metered in Tenderly Units) remove anvil
  entirely for the public test, at the cost of a vendor bill and no `evm_setNextBlockTimestamp`
  control over the practice clock. Conduit-style rollup testnets start ~$50/mo and are
  overkill until mainnet rehearsal. [TENDERLY] [CONDUIT]

## 3. Real-time transport: from 400 ms polling to push

**Finding.** The arcade polls the chain (scoreboard 400 ms, keeper 250 ms) through
the gateway's `/api/invite/rpc`. That is fine at one table, but every phone is a
poller, and the gateway serialises them onto anvil. anvil serves WebSocket on the
same port (`eth_subscribe newHeads/logs`); ethers v6 `WebSocketProvider` delivers
real subscriptions **only when listeners are attached directly to it** (inside a
`FallbackProvider` it silently polls; `tx.wait()` polls regardless). Cloudflare
proxies WebSockets by default; Cloudflare Tunnel too. [ETHERS-4932] [ETHERS-965] [CFT]

**Recommended:** the keeper (one process, already the source of truth for round
timing) subscribes to anvil over WebSocket and **fans out a single Server-Sent
Events stream** (`/api/invite/feed`: round opened / sealed / settled / lottery draw
with server timestamps). Phones hold one SSE connection instead of 2.5 polls/s;
the clock re-anchor uses the server timestamp on each event. SSE survives
Cloudflare and Passenger without WebSocket upgrade handling, reconnects natively,
and is ~40 lines in the gateway. Keep polling as the fallback path.

## 4. Mobile rendering budget (iOS Safari / Android Chrome)

**Findings (industry guidance, 2026):** cap DPR at 2 (1× budget, 1.5× mid, 2× flagship);
render post-processing at **half resolution** (≈2× frame rate in fill-bound scenes);
mobile shadow maps 512–1024 with the cheap filter; **~100 draw calls/frame** on
mobile; disable native MSAA when a composer runs and finish with SMAA/FXAA; `mediump`
shaders; KTX2/Basis textures (4–8× less GPU memory); InstancedMesh/BatchedMesh for
repeats; a `PerformanceMonitor`-style governor that steps DPR. OffscreenCanvas +
WebGL2 in a worker works on iOS 17+; SharedArrayBuffer for the physics worker needs
COOP/COEP headers. [UTSUBO-100] [MDN-OFFSCREEN] [WEBDEV-OFFSCREEN]

**WebGPU:** Safari 26 (Sept 2025) shipped WebGPU on iOS; three.js `WebGPURenderer`
falls back to WebGL2 automatically. Migration cost is the post chain: `EffectComposer`
passes (UnrealBloom, god-rays, lens-flare GLSL) must become TSL node effects
(`bloom()` exists; custom passes are rewrites) — 1–3 days for our chain. Gains are
2–10× on draw-call-heavy scenes; ours is fill-bound, so the half-res post fix
matters more. Defer WebGPU until after the public test. [UTSUBO-2026] [UTSUBO-MIG] [IOS26]

**Applied now:** phones get the low post tier, PCF shadows, 120 Hz/8-iter physics,
machine build deferred to the crash beat; 1.5× DPR kept with the governor.

**Best-in-class next (in order):**
1. **Half-resolution post chain on phones** (bloom/god-rays at 0.5×, composite at
   full) — the single largest win still available; keeps the look.
2. **Shadow map 1024 → 512 on phones**, `light.shadow.autoUpdate=false` for the
   static pad; count draw calls with `renderer.info` and batch the pad/gantry.
3. **KTX2 textures** for the launch environment (the 1.7–2.4 MB PNG scenes are
   decoded to uncompressed RGBA on the GPU).
4. **Physics in a worker with SharedArrayBuffer** (needs
   `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
   require-corp` on `/arcade/*` — check every third-party asset is CORP-clean first).
5. **Pause the lottery renderer** whenever the dialog is closed (it is, for the stage;
   confirm the machine's loop stops too).

## 5. Asset delivery and cache invalidation

**Findings.** Cloudflare's zone Browser Cache TTL only *extends* browser caching
("longer than the edge but not less") and applies its own value when the origin
sends none or a lower `max-age`; `no-store` passes through; Cache Rules can set
Browser TTL to **Respect origin** or **Bypass** for a path prefix (`URI Path starts
with /arcade/`). Purging the edge never clears visitors' browsers. [CF-BROWSER-TTL] [CF-RULES] [CF-CC]

**Applied now:** the gateway stamps every arcade entry link and static import with a
per-deploy fingerprint (`?v=…`, 24 refs), and `/arcade/*` (minus vendor/ and art/)
is `no-store` end-to-end — a deploy is a new URL, the old cache is never asked.

**Best-in-class next:** content-hashed filenames built by esbuild for the arcade
modules (`lottery-theatre.[hash].js`) with `Cache-Control: public, max-age=31536000,
immutable`, plus the one Cache Rule above. Same guarantee, and repeat loads become
free instead of `no-store` revalidations. Vendor (three/rapier) is already immutable
in practice; give it a versioned path so a future upgrade can never be half-cached.

## 6. Deploy discipline (what made #2 happen)

- `deploy-table` (bundles + supervisor + arcade files, ~4 min) and a `master` push
  (full site, ~35 min, restarts the table at the end) **must never overlap**: they
  collide on the host's SSH and restart the table twice within a minute.
- Open-source Passenger has no rolling restart (Enterprise only); each full deploy
  is a cold start. With the table on its own VPS (§1A) the site deploy stops
  touching the game at all.
- `diagnose-app` (new op) prints processes/RSS/log tails/restart; run it before
  assuming the table is at fault.

## 7. Execution plan (recommended order)

| Step | Effort | Removes |
|---|---|---|
| 1. Table on a €5 VPS via Cloudflare Tunnel; systemd units; atomic state dump; 0.5 s blocks | 1 day | #1, #2, deploy coupling |
| 2. Half-res post on phones + 512 shadow maps + draw-call pass | 0.5 day | #4 residual lag |
| 3. Keeper → SSE feed; phones stop polling | 0.5 day | jitter, gateway load, "web-socket tick" feel |
| 4. Content-hashed arcade bundles + Cache Rule | 0.5 day | #3 forever, faster repeat loads |
| 5. KTX2 textures; SAB physics with COOP/COEP | 1 day | GPU memory, remaining hitches |
| 6. Mesh fan-out cap + LVE increase request | hours | site-wide 503 class |
| 7. WebGPU renderer + TSL post chain | 1–3 days | future headroom (after the test) |

## Sources

- [CL-EP-NPROC] https://cloudlinux.zendesk.com/hc/en-us/articles/115004516985-EP-and-NPROC-limits-a-look-from-inside
- [CL-FORK] https://cloudlinux.zendesk.com/hc/en-us/articles/5958079971228-The-received-data-is-wrong-fork-retry-Resource-temporarily-unavailable
- [LSWS-CL] https://docs.litespeedtech.com/lsws/cp/cpanel/ts-cloudlinux/
- [FLY] https://fly.io/pricing/ · https://deployhandbook.com/pricing/fly-io
- [HETZNER] https://www.hetzner.com/pressroom/new-cx-plans/ · https://vpsfor.dev/posts/hetzner-cx22-pricing-2026/
- [CFT] https://dev.to/recca0120/cloudflare-tunnel-in-2026-expose-localhost-without-opening-ports-or-buying-an-ip-32l5
- [ANVIL-REF] https://www.getfoundry.sh/reference/anvil/anvil
- [ANVIL-6017] https://github.com/foundry-rs/foundry/issues/6017
- [ANVIL-8392] https://github.com/foundry-rs/foundry/issues/8392
- [ANVIL-4252] https://github.com/foundry-rs/foundry/issues/4252
- [TENDERLY] https://docs.tenderly.co/virtual-testnets · https://docs.tenderly.co/virtual-testnets/pricing
- [CONDUIT] https://www.gate.com/learn/articles/what-is-conduit/6624
- [ETHERS-4932] https://github.com/ethers-io/ethers.js/issues/4932
- [ETHERS-965] https://github.com/ethers-io/ethers.js/issues/965
- [UTSUBO-100] https://www.utsubo.com/blog/threejs-best-practices-100-tips
- [UTSUBO-2026] https://www.utsubo.com/blog/threejs-2026-what-changed
- [UTSUBO-MIG] https://www.utsubo.com/blog/webgpu-threejs-migration-guide
- [IOS26] https://appdevelopermagazine.com/webgpu-in-ios-26/
- [MDN-OFFSCREEN] https://github.com/mdn/browser-compat-data/issues/21127
- [WEBDEV-OFFSCREEN] https://web.dev/articles/offscreen-canvas
- [CF-BROWSER-TTL] https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/set-browser-ttl/
- [CF-RULES] https://developers.cloudflare.com/cache/how-to/cache-rules/settings/
- [CF-CC] https://developers.cloudflare.com/cache/concepts/cache-control/
- [PASSENGER-ROLLING] https://www.phusionpassenger.com/library/deploy/apache/zero_downtime_redeployments/nodejs/
- [IOS-DIALOG] https://github.com/tailwindlabs/tailwindcss/pull/19364 · https://iifx.dev/en/articles/460170745/fixing-ios-safari-s-shifting-ui-with-dvh
