# Grok findings: Unified Mesh Continuum — one architecture across every chain

Source brief: `GROK-RESEARCH-BRIEF-unified-maximal-hydration-2026-08-26.md`.
Grok's response preserved verbatim below, followed by this app's own build
decision.

## Grok's response (verbatim)

**Unified architecture findings — one model, every chain**

---

### Research verdicts (applicable vs not)

#### 1. Production multi-chain indexers

| System | Pattern | Applicable here? |
|--------|---------|------------------|
| **SQD** | One processor per chain → shared Postgres; historical bulk from data network | **Yes conceptually**: per-chain extract, shared facts DB — matches your mesh lanes + shared tables |
| **The Graph** | Subgraph per deployment; Horizon modular services | Economics/staking not free-tier; pattern of sealed compute ≠ your VPS |
| **Envio HyperSync** | Bulk filtered logs for EVM | **Already adopted** for EVM fills |
| **Goldsky** | Managed stream + Flink | Paid infra — out of scope |

**Verdict:** Unified *serving* + per-chain *extract* is the proven pattern. Do not invent one decoder for EVM logs + Solana GPA + Bitcoin UTXOs. Unification lives in **control plane, demand, pacing, archival, and schema legs** — not in a universal binary parser.

**Label:** Adopt proven multi-chain pattern (you largely have it).

---

#### 2. Crawler / frontier theory

Search engines schedule recrawl from **observed change rate**, not flat TTLs (change period → crawl period; LambdaCrawl-style budget allocation).

**Applicable:** Track "did floor/listing/membership hash change since last hydrate?" → adjust next due time.
**Not applicable:** ML change predictors that burn free-tier budget validating themselves.

**Label:** Adapt adaptive recrawl to collection hydrate outcomes (honest binary change detection).

---

#### 3. Predictive prefetch beyond viewport

You already have viewport + rank adjacency. CDN/recommender pre-warm at web scale often **over-fetches**. At free-tier + modest traffic, aggressive ML prediction is negative EV (wastes CU on misses).

**Verdict:** Keep prediction cheap: visible → adjacent ranks → detail siblings → archival frontier. Do not add collaborative filtering until traffic proves residual headroom after FBC.

**Label:** Amplify existing prediction; reject heavy demand models for now.

---

#### 4. P2P / browser contribution

Your OAL already compounds visitor-triggered verified writes. Asking browsers to run extractors crosses into "client does server work," breaks signer discipline, and opens poison/waste attacks.

**Verdict:** Visitors **seed demand only**; server always verifies. No browser miners.

**Label:** Already built the safe half; do not federate extract to clients.

---

#### 5. Documented rate limits (cite only real docs)

| Provider | Documented free behavior | Pace model |
|----------|--------------------------|------------|
| **OpenSea** | Hourly budget you already pace (6.2s / 600/hr) | Atomic pace slot — **done** |
| **Alchemy** | Free: **300 CU/s** base; throughput as **token bucket over ~10s window**; monthly CU cap 30M | Continuous token bucket in CU, not "1 call / N ms" only |
| **Helius free** | **10 RPC/s**, **2 DAS/s**, **getProgramAccounts 5/s** | Per-method RPS buckets |
| **HyperSync** | Not a classic RPS NFT API; treat as I/O + your own concurrency bound | Concurrency lease, not vendor RPS guess |
| **mempool.space** | Public etiquette; no single hard published "NFT index RPS" in your prior work — **do not invent** | Conservative fixed spacing + 429 jail only if observed |
| **UniSat** | Use only documented free key limits you already treat as real | Same pace-slot pattern when limit is numeric |

**Label:** Generalize `claimOpenSeaPaceSlot` → `claimProviderPaceSlot` with **per-provider documented parameters only**; absent citation → no fake ceiling (your source-budget rule).

---

#### 6. Spawn-per-job vs long-lived workers

**Recommendation: Hybrid** — short-lived child processes for heavy/unsafe lanes (HyperSync scans, GPA scans), long-lived in-process workers for tiny I/O jobs (evm-metadata batches). Supervisor still restarts workers; job lease in Postgres remains source of truth.

**Label:** Adapt production pool patterns to crash-resilient Postgres leases.

---

#### 7. Unattended forever backfill — failure modes

Real production hygiene: per-round backoff when jailed/empty, disk/row budget circuit, heartbeat + progress cursor, stale-run detector, never tight-loop on permanent error.

**Label:** Adopt observability bounds on genesis/frontier lanes already run.

---

### One architecture: Unified Mesh Continuum (UMC)

Evolution of what exists — not a parallel system. DEMAND → CONTROL PLANE
(plank_data_jobs) → [PACE LAYER / WORKER LAYER / EXTRACT LAYER, chain
adapters unchanged] → FACTS + ARCHIVAL LEDGER → LIVE PATH
(singleflight + freshness-budget).

**Unification boundary (honest):** job schema, priorities, pace API,
archival score, FBC, singleflight, cursor store, jail, supervisor health,
and auto-backfill *policy* are unified everywhere. Decoder implementations
(HyperSync logs vs GPA vs UTXO settlement) and what "next cursor" means
per chain stay chain-family specific.

### Build order given (value/effort)

1. Extract OpenSea pacer → `claimProviderPaceSlot` + Helius RPS profiles
2. `mesh_lane_health` + stalled detection on tick
3. Light job worker loop for metadata-sized jobs
4. Fingerprint + `nextHydrateDelayMs` on collection hydrate
5. Backfill scripts: mandatory backoff on jail + disk soft-guard
6. Skip ML prediction and browser-side extract

(Full response including real TypeScript for `claimProviderPaceSlot`,
`nextHydrateDelayMs`, and the `mesh_lane_health`/`provider_pace_state`
schemas is preserved in the conversation this brief was answered in; code
below is this app's own re-verified implementation, not a blind copy.)

## Build decision

Adopting build-order items **2, 4, 5, and 1's mechanism** this pass.
Deferring items **3 (light worker pool)** and **1's specific per-provider
numbers (Alchemy/Helius profiles)** — see reasoning below. Rejecting **6**
outright per Grok's own verdict (already this app's standing rule).

- **#2 `mesh_lane_health` + stalled detection — BUILT.** Pure
  observability, zero citation risk, directly answers this app's own
  standing "no human log-watching" requirement. Real heartbeat/progress
  columns, updated by mesh-tick itself.
- **#5 backfill disk/jail guards — BUILT**, generalized to every
  `scripts/*-backfill-pass.mjs`/`*-discovery-pass.mjs` script, not just
  the one (`genesis-seaport-backfill-pass.mjs`) fixed 2026-08-25. Re-audited
  the sibling scripts directly rather than trusting Grok's "adopt" label
  on faith — see per-file notes in the diff.
- **#4 adaptive recrawl — BUILT** as `nextHydrateDelayMs`, wired into the
  Freshness Budget Controller as an additional per-collection signal
  layered on top of (never replacing) the existing provider-pressure TTL
  widening — a genuinely honest binary "did this actually change"
  fingerprint, no invented volatility score.
- **#1 mechanism (`claimProviderPaceSlot`) — BUILT**, generalizing
  `claimOpenSeaPaceSlot`'s already-shipped, already-DB-verified atomic
  pattern (`min_interval_ms` mode only this pass — the `token_bucket` mode
  Grok's draft included has a real bug: its final `UPDATE ... WHERE
  u.tokens >= $4` silently no-ops without returning a row when the bucket
  is empty, so the caller-side `rows[0]?.allowed` check reads `undefined`
  as "not allowed" but never advances `last_refill_at` correctly across
  that no-op case in the way the `min_interval_ms` mode does — needs a
  clean second pass, not shipped as-drafted).
- **#1 specific numbers (Alchemy 300 CU/s, Helius 10/2/5 RPS) — NOT
  wired as live gates this pass.** This app has a strict, repeatedly
  enforced rule (see `source-budget.ts`'s own history of REMOVING several
  self-imposed ceilings once no primary citation could be reproduced live)
  against gating real throughput on a number that hasn't been independently
  confirmed against the provider's own current docs by this session, not
  inherited from an external response. Helius's free-tier RPS figures
  broadly match what `helius-key-pool.ts`/`source-budget.ts` already found
  live 2026-08-23 (RPS-by-tier, no flat daily count) but the exact
  2/10/5 method-split needs a live doc check before it gates anything;
  Alchemy's 300 CU/s + 30M monthly figure is plausible but equally
  unverified live this pass. `claimProviderPaceSlot` is built and ready to
  register real profiles the moment each is confirmed — registering an
  unverified number now would repeat exactly the mistake this file's own
  history exists to prevent.
- **#3 light worker pool — DEFERRED**, not rejected. Real, valuable
  architecture change (removes Node+tsx cold-start cost from every 6-token
  metadata batch), but changes this app's crash-isolation model for a
  meaningful slice of real production traffic — warrants its own
  dedicated pass with real before/after throughput measurement, not a
  same-session bundled change alongside four other things.
- **#6 (ML prediction, browser-side extraction) — explicitly not built**,
  per Grok's own verdict: negative expected value at this app's real
  traffic scale, and browser-side extraction would violate this app's own
  real-signer/server-verifies discipline.
