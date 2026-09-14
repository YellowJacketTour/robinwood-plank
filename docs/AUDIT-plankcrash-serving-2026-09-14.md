# PlankCrash serving audit — where the approach was wrong, and the free way to serve it (2026-09-14)

Owner's brief: "there are obviously way superior entirely free solutions… you bungled
something fundamental in the approach to serving this stack." This document is the
reconciliation: what the codebase actually does on a page load and per second on
plank.love (measured), which of it is structurally wrong, and the all-free
architecture that fixes it. Companion research (paid options, GPU budgets, cache
semantics): `RESEARCH-plankcrash-performance-scaling-2026-09-14.md`.

## 1. Measured on plank.love (Chromium, invite link, 30-minute session)

| Metric | Measured | Verdict |
|---|---|---|
| Transport | HTTP/3 via Cloudflare | fine |
| DOMContentLoaded / load | 977 ms / 1,100 ms | fine |
| Requests on one page load | **250** (54 scripts, 4 PNG, 10 JSON, 177 `/api/invite/*`) | wrong |
| Script bytes decoded | **5.98 MB** (rapier 2.0 MB ×2, three 1.28 MB, ethers 0.51 MB) | wrong: module graph loaded twice |
| Image bytes | **8.96 MB** in four PNGs (titanium 2.4, cosmic-relics 2.4, chalkstronaut-front 2.3, launch-coast 1.8) | wrong: WebP is 0.10–0.34 MB each |
| RPC calls recorded | 171 in the perf buffer; **average 1,156 ms** each | wrong: the single hop costs 150 ms |
| One `eth_blockNumber` from outside (curl) | 141–277 ms; gateway-only `/clock` 145–178 ms | the hop itself is fine |
| Poll loops in `crash.html` | `refresh` @ 400 ms; `pollScoreboard + refreshVault + refreshPowerboardUI + pollLiveBoard` @ 400 ms; 20 read sites | wrong: per-client chain polling |
| ethers provider | `batchStallTime 80, batchMaxCount 40` → ~1 HTTP batch per tick per loop | good, but every player repeats it |
| Gateway | executes every call of every player against anvil, `inflight ≤ 32`, 1,600 calls / 10 s per guest | no sharing between players |
| Path per call | browser → Cloudflare → Passenger → next-server rewrite proxy → gateway → anvil | two hops too many |

**Why the in-page average is 8× the hop:** five interval loops per tab fire ~20
reads every 400 ms; with the 80 ms batch window that is 2–3 HTTP batches per tick,
each waiting on ~20 sequential-ish anvil reads behind a single next-server proxy
and a single gateway process. Two tabs double it. Twenty phones in a public test
would have been forty-fold — the queue is the game, not anvil.

## 2. The fundamental mistakes (and the fixes, all free)

### M1 — Serving a real-time chain game through a page-server on shared hosting
The arcade is static (HTML + ES modules + WebGL). It was placed under Next's
`public/`, so every byte and every `/api/invite/*` call is proxied by
next-server under Passenger on a CloudLinux account whose NPROC/EP ceiling took
the whole site down on 2026-09-14 (`fork: retry: Resource temporarily unavailable`),
and whose cache headers Cloudflare then rewrote.

**Fix (free):** serve the arcade as **Cloudflare Workers static assets** (free,
unmetered requests and bandwidth, Brotli/HTTP3/immutable caching, 20k files) and
route `/api/invite/*` straight to the gateway through a **Cloudflare Tunnel**
(free, WebSockets on by default). Passenger leaves the hot path entirely; the site
can deploy without touching the game. [W-ASSETS] [CFT]

### M2 — Every client polls the chain
Twenty reads per client per 400 ms is a single-player design. The keeper already
knows every round transition first.

**Fix (free, two layers):**
1. *Now (no arcade changes):* the gateway memoises chain-head reads per block and
   coalesces in-flight duplicates (`sharedRead` — eth_call/logs/blocks/balances at
   `latest`, 400 ms TTL, never writes/receipts/nonces). N players cost anvil one
   read per block per distinct call.
2. *Next:* the keeper publishes one round snapshot (`round, phase, seats, chainNow,
   quote, draw`) and the gateway serves it as **one JSON** (`/api/invite/state`) and
   as **Server-Sent Events** (`/api/invite/feed`). The arcade's `readRoundSnapshot`
   becomes a snapshot read; polling stays as fallback. On Cloudflare this fan-out is
   a **Durable Object with WebSocket hibernation** (free tier: 100k req/day, SQLite
   DOs) if the audience outgrows one gateway process. [DO-FREE] [DO-WS]

### M3 — The chain on the same account as the website
anvil at 811 MB RSS plus its supervisor/cron forks lived next to the mesh, the
hose, the stream and the site. One burst from any of them starves all.

**Fix (free):** run anvil + keeper + gateway on an always-free VM and expose it via
Cloudflare Tunnel: **Oracle Cloud Always Free** (Ampere A1: now 2 OCPU / 12 GB
after the June 2026 halving; reclaimed if idle <20 % CPU over 7 days — the keeper's
0.1–0.5 s blocks keep it busy) or **Google Cloud e2-micro** (permanent, 1 GB egress/mo
— enough for RPC, not for art; art is on Workers assets anyway). Fly's free tier is
gone. systemd `Restart=always` replaces cron+flock; state dumps become atomic
(`tmp → rename`). [ORACLE] [ORACLE-HALVED] [GCP] [FLY-GONE]

### M4 — Assets shipped raw
9 MB of PNG on every first load (and 4 h of Cloudflare browser cache when the file
changes, but no cache-busting). rapier is fetched by two workers.

**Fix (free):** WebP now (done: 8.96 MB → 0.81 MB, sharp q82), **KTX2/Basis** for
GPU textures next (4–8× less GPU memory, no decode stall), content-hashed
filenames + `immutable` on Workers assets, one physics worker shared by lottery and
prize showcase (saves 2 MB decode + a WASM instantiation per open). [UTSUBO-100]

### M5 — Cache-busting by rewriting module specifiers (my error, this week)
Stamping `from "./x.js"` in crash.html while `lottery-theatre.js` still imported
`./x.js` gave the browser two URLs for one module → two instances of three, rapier
and every singleton, 54 script requests. **Fix (done):** stamp entry links only;
`/arcade/*` is `no-store` end-to-end (verified passing Cloudflare); the permanent
answer is content-hashed builds (M4).

### M6 — Deploy collisions
`deploy-table` and a `master` push both restart the table; overlapping them tore
anvil's state file. **Fix (done):** torn-state detection with fallback; **rule:**
never run both at once. With M1/M3 the site deploy no longer touches the game.

## 3. The all-free target architecture

```
phones/PCs ──HTTP/3──▶ Cloudflare edge
                         ├─ Workers static assets:  /arcade/*  (immutable, hashed, Brotli)   free
                         ├─ Worker (100k req/day):  /api/invite/join|session|refill          free
                         └─ Cloudflare Tunnel ─────▶ gateway :8766  /api/invite/rpc|state|feed
                                                      keeper  (WS-subscribed to anvil, publishes snapshot/SSE)
                                                      anvil   (systemd, atomic state, 0.5 s blocks)
                                                     on Oracle Always-Free A1 (2 OCPU/12 GB) or GCP e2-micro   free
plank.love (Next on InMotion) keeps only: /table → 302 to the arcade host; /playtest host credentials
```

Cost: €0. What it removes: Passenger from the hot path, the shared account's
process ceiling, the 4 h cache fight, per-client chain polling, deploy coupling.

## 4. Codebase items found by the audit (beyond the six mistakes)

- `crash.html` is a 7,000-line single module; the module graph is 23 files + 3
  vendor libs, unbundled. Keep it unbundled for Safari (large single bundles
  deoptimise 6–8× in Safari [ESBUILD-478]) but emit **hashed filenames** and a
  `<link rel=modulepreload>` list so the graph loads in one round trip.
- Two 400 ms interval families run independently (`refresh` and the scoreboard
  quartet) → merge into one scheduler ticking off the snapshot.
- `readRoundSnapshot` + `admissionsPaused` + `pendingLotteryRound` + vault +
  powerboard + live board reads every tick: ~20 `eth_call`s that change at most
  once per block. With M2 they become one snapshot; until then `sharedRead` makes
  them one anvil read each per block for everyone.
- The keeper uses `provider.pollingInterval = 250` over HTTP; subscribe over anvil's
  WebSocket (`eth_subscribe newHeads`) and act on the head event.
- `lottery-physics-worker.js` and `prize-physics-worker.js` each import rapier
  (2 MB decoded, WASM init) → one shared physics worker.
- Post-processing (bloom, god-rays, lens-flare) runs at full resolution on phones →
  half-resolution passes (≈2× fps in fill-bound scenes) [UTSUBO-100].
- PNG → WebP done; textures → KTX2 next.
- Gateway guest limits (1,600 calls/10 s, 32 in flight) were sized for one
  player; with `sharedRead` the anvil side is bounded, the per-guest counters stay.

## 5. Execution order (all free)

1. **Done today:** `sharedRead` memo/coalesce; WebP art; single module graph;
   torn-state fallback; explicit phone tiers; no-store + entry stamps.
2. Arcade → Workers static assets (hashed files, `_headers` immutable); `/table` on
   plank.love becomes a redirect. Half a day.
3. Cloudflare Tunnel from the current host to the gateway; Next rewrites removed
   from the hot path. Two hours. (Reversible; same code.)
4. Keeper snapshot + `/api/invite/state` + SSE feed; arcade reads the snapshot.
   One day.
5. Chain + keeper + gateway to Oracle Always-Free / GCP e2-micro under systemd with
   atomic state dumps. Half a day. Site deploys stop touching the game.
6. Half-res post chain, KTX2, one physics worker. One day.

## Sources

- [W-ASSETS] https://developers.cloudflare.com/changelog/post/2025-09-02-increased-static-asset-limits/ · https://www.morphllm.com/comparisons/cloudflare-pages-vs-workers
- [CFT] https://dev.to/recca0120/cloudflare-tunnel-in-2026-expose-localhost-without-opening-ports-or-buying-an-ip-32l5
- [DO-FREE] https://developers.cloudflare.com/changelog/2025-04-07-durable-objects-free-tier/
- [DO-WS] https://developers.cloudflare.com/durable-objects/examples/websocket-server/ · https://developers.cloudflare.com/durable-objects/platform/pricing/
- [ORACLE] https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- [ORACLE-HALVED] https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/
- [GCP] https://cloud.google.com/free/docs/compute-getting-started
- [FLY-GONE] https://fly.io/docs/about/discontinued-plans/
- [UTSUBO-100] https://www.utsubo.com/blog/threejs-best-practices-100-tips
- [ESBUILD-478] https://github.com/evanw/esbuild/issues/478
- [CF-WORKERS-PRICING] https://developers.cloudflare.com/workers/platform/pricing/
