# Grok findings: unified vision under real constraints (2026-08-25)

Response to `GROK-RESEARCH-BRIEF-biggest-issues-unified-vision-2026-08-25.md`,
preserved verbatim below for the record. See the bottom of this file for a
synthesized recommendation and proposed build order.

---

**Research + invention brief: unified vision under real constraints**

Ground truth from your audit is accepted. Prior art alone does not close these gaps; where it falls short, the designs below are explicit **novel synthesis** for *this* stack (Postgres-only, `PGPOOL_MAX=4`, free-tier-first, Next.js standalone, fail-closed, unaudited trading blocked until audit).

---

## Issue 1 — Interim safety for unaudited fund-moving code

### Prior art (real, citable)

- **Capped launches**: MixBytes recommends launching with TVL capped at roughly the future max white-hat bounty so a live exploit is a bounded CTF, not a protocol death event.
- **Programmable spend limits**: Session keys / policy engines with per-tx, per-period, allowlist, and kill-switch (Coinbase Agentic Wallets, ERC-4337/7715 patterns).
- **Subaccount isolation**: Binance Agent OS uses subaccount balance as the hard loss ceiling; no separate agent-loss limit beyond what the user funded.

None of these is a ready-made "aggregator of foreign marketplace inventory with unaudited routing" pattern. They are ingredients.

### Novel mechanism: **Bounded Blast-Radius Canary (BBRC)**

**Idea (not seen as a packaged product in aggregator form):** treat every foreign-chain fulfill path as a *canary surface* whose worst-case loss is made **economically and operationally survivable**, with a **quantified residual risk statement** you can put in terms/UI—not "trust us."

**Enforcement (server-side only; no client trust):**

| Dimension | Cap type | Example alpha defaults | Where enforced |
|-----------|----------|------------------------|----------------|
| Per trade | Hard USD notional | $25–50 | Before any PSBT/tx construction |
| Per wallet / 24h | Rolling sum | $100–200 | Postgres ledger of canary fills |
| Global / 24h | Rolling sum | $1,000–2,500 | Same ledger |
| Per venue / chain | Independent buckets | e.g. BTC $500/day, Sol $500/day | Same |
| Kill switch | Feature flag | `FOREIGN_TRADE_CANARY=0` | Instant disable, no deploy |

Implementation fits your constraints: one small Postgres table (`canary_fill_ledger`: wallet, venue, chain, usd_notional, tx_ref, created_at) updated in the same request path that currently builds the trade. With `PGPOOL_MAX=4`, use a single short transaction: `SELECT … FOR UPDATE` on a day-bucket row or optimistic check-then-insert; fail closed if over cap. No Redis.

**Quantifying how much risk a cap removes (defensible posture, not math theater):**

Define:

R_residual ≈ P(exploit path) × min(C_global, C_wallet × N_wallets)

You cannot know P precisely pre-audit. What you *can* state honestly:

1. **Maximum protocol-side loss under any single logic bug in canary paths** ≤ global daily cap (and ≤ sum of wallet caps that day).
2. **User-side loss** for any one wallet ≤ that wallet's rolling cap (and only if they opted into canary foreign trades).
3. **Native RobinWood/Seaport path** remains out of canary (already audited scope)—do not dilute that claim.

Present as: *"Foreign-chain trading is in Bounded Blast-Radius Canary. Maximum aggregate notional through unaudited routers is $X/day; per-wallet $Y/day. Native Marketplank fills are not subject to this canary."*

**Progression ladder (tie expansion to evidence, not calendar):**

1. Canary: caps + only venues with live-tested adapters + mandatory extra confirm UI.
2. Expand caps only when: unit/integration tests cover every fund-moving function; at least one external review of those files; legal disclosure live.
3. Full open only after third-party audit of `foreign-fulfill.ts` / `native-fulfill.ts` / Solana/Bitcoin trade modules.

**Blocked on audit flag:** any proposal that *removes* caps or adds new fund-moving paths without audit stays explicitly blocked. BBRC is interim only.

**Confidence:** High that capped-launch + policy limits are proven elsewhere; medium-high that BBRC as a named, multi-bucket, Postgres-ledger posture is a **novel packaging** for multi-venue NFT aggregators.

---

## Issue 2 — Graceful degradation under hard free-tier QPS

### Prior art

- Cloudflare probabilistic revalidation under load.
- Dynamic TTL as a function of provider load (longer TTL when load is high).
- Your own singleflight + SWR in Postgres is the right local primitive.

Missing piece: **multiple independent upstream quotas** feeding one shared read surface, with **honest age labels**, under a tiny connection pool.

### Novel mechanism: **Freshness Budget Controller (FBC)**

**Core idea:** treat each provider's free-tier QPS as a **budget**, not a cliff. As spent budget rises, *automatically widen effective TTL and prefer serving labeled-stale cache* so the system never "breaks for everyone."

**State (Postgres only):**

```text
provider_budget(
  provider text PK,           -- helius, alchemy, unisat, ...
  window_start timestamptz,
  calls_used int,
  soft_ceiling int,           -- e.g. 80% of known free RPS*window
  hard_ceiling int
)

cache_meta already implied by singleflight-cache:
  key, payload, fetched_at, source_provider, ttl_base
```

**On each would-be upstream call:**

1. Coalesce via existing singleflight lease.
2. Before fetch: read `calls_used` for provider in current window.
3. Compute **pressure** p = calls_used / soft_ceiling.
4. Effective TTL:

TTL_eff = TTL_base × (1 + k × p²)

(example k=3: at full soft ceiling, TTL ≈ 4× base). Cap at a max (e.g. 15–30 min for floors).
5. If `calls_used >= hard_ceiling`: **do not call upstream**. Serve last cache if present with header/body field `data_age_seconds` + `freshness: "stale_budget"`. If no cache: fail closed with explicit `provider_budget_exhausted` (never fabricate).
6. Increment `calls_used` only on real upstream attempts (success or fail).

**Per-route policy (not one global TTL):**

| Data class | Base TTL | Max under pressure | Fail mode |
|------------|----------|--------------------|-----------|
| Floor / best bid | 30–60s | 10–15 min | Stale OK if labeled |
| Recent sales | 60–120s | 20 min | Stale OK |
| Collection discovery | 10–30 min | 2–6 h | Stale OK |
| Live listing for *this* fulfill | 0–15s | still short | Prefer fail closed over stale for **trade** path |

**UI contract:** every market number carries `as_of` + optional `freshness: live | cached | stale_budget`. Under budget pressure the product gets *slower to update*, not *wrong* or *down*.

**Why this is not off-the-shelf:** classic adaptive TTL assumes one origin. FBC is a **multi-provider budget fabric** sitting *above* singleflight, tuned for free-tier hard ceilings and honest degradation labels—designed for your Postgres-only, low-pool reality.

**Confidence:** High on dynamic TTL literature; medium-high that FBC as specified is novel synthesis for multi-API NFT aggregators.

---

## Issue 3 — Data without gated venues

### 3a. Tensor: on-chain settlement scanner (high leverage, free)

**Finding:** Tensor's book API is gated; **settled trades are not**. Public Solana RPC sees program interactions. Tensor Swap / marketplace program activity is already parsed by explorers as NFT sales (`TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN` and related; instructions such as `SellNftTokenPool` / buy paths; events with amount, asset id).

**Design (mirrors your HyperSync Seaport pattern):**

1. Maintain known Tensor program IDs (from `tensor-solana-trade.ts`).
2. Scanner job: `getSignaturesForAddress(program)` or block-subscribe → fetch txs → decode instructions/logs → extract `{mint, price_lamports, buyer, seller, slot, sig}`.
3. Upsert into Postgres `onchain_fills(chain, venue, mint, price, ts, tx)`.
4. Derive **activity floor** = min(price) over rolling window of *settled* fills for collection mints you already track—not the live order book.
5. Label explicitly: `source: onchain_settlement`, `book_visibility: none`.

**What it solves:** free, always-on activity and realized price for Tensor without API key.
**What it does not:** open listings, bids, or true book depth.
**Honesty rule:** never present settlement floor as "Tensor floor" without the settlement label.

This is the Solana analogue of what you already do for EVM fills—**known pattern applied to Tensor for the first time in this codebase**, not pure invention.

### 3b. Bitcoin Ordinals: chain-first limits (honest boundary)

**Finding:** Major Ordinals markets use **off-chain PSBT orderbooks + on-chain settlement**. Listing = signed PSBT held by the venue; inscription stays in seller UTXO until a buyer completes the PSBT.

Therefore:

- **Open listings cannot be derived from Bitcoin chain state alone.** No amount of engineering recovers UniSat/Magic Eden/OKX books from blocks.
- **Confirmed sales can** be observed as inscription-bearing UTXO spends. Heuristics (known marketplace fee outputs, standard SIGHASH patterns) improve labeling but are incomplete and must be labeled `inferred_settlement`.
- Mempool aggregators (Satflow-style) see pending settlements early but are commercial/API-gated.

**Do not claim a pure on-chain Ordinals orderbook.** Claim a **settlement index** + marketplace feeds you already have (UniSat free key path, etc.).

### 3c. Federated light indexing (genuinely under-solved — sketch only)

No production protocol was found that shards full Ordinals indexing across many ~30 GB operators with dispute-safe aggregation. OPI-LC is BRC-20-oriented, not NFT catalog.

**Novel sketch — "Shard-Attested Settlement Log" (SASL)** (research prototype, not production claim):

1. **Data unit:** confirmed inscription transfer events only (txid, vin/vout, inscription ids, block height)—not full content index.
2. **Shard:** by `block_height % N` or `txid` prefix; each operator indexes only their shard from a pruned or partial source if possible, or from public block filters.
3. **Attestation:** operator publishes Merkle root of shard events + height range to a cheap public log (Nostr, Bitcoin inscription, or your Postgres if they push signed bundles).
4. **Aggregation:** Marketplank accepts roots from ≥k distinct keys; intersects event sets; disputes = challenge period with fraud proof = single missing/extra tx demonstrable from Bitcoin.
5. **Incentive:** reputation + optional tip for serving rare collection queries—not a full token design.

This does **not** replace OPI for complete historical content. It could, in theory, distribute *settlement* coverage. Treat as long-horizon R&D, not alpha path.

### 3d. Architecture that does not depend on any single gated venue

```text
Layer A — Protocol-native / free bulk (you already lean here)
  OpenSea collections, UniSat registry, Helius DAS MplCore, on-chain EVM logs

Layer B — Settlement scanners (expand)
  HyperSync-style EVM (exists)
  Tensor program log scanner (new)
  Bitcoin confirmed inscription-spend indexer (partial, labeled)

Layer C — Marketplace feeds (opportunistic)
  Whatever free/self-serve keys exist; fail closed when absent

Layer D — Honesty surface
  venue-registry coverage + inline completeness (Issue 4)
```

Unified vision becomes **"same product shell, tiered truth"**, not fake parity.

---

## Issue 4 — Completeness visible at decision time

### Proven UX patterns (aggregators / terminals)

- **Source chip** on the number: `OpenSea · live` / `Tensor · settlements only` / `UniSat · 12m ago`
- **As-of timestamp** always visible on floors and last sale
- **Coverage bar** on collection header: `Book: partial · Sales: on-chain · Listings: 2 of 5 venues`
- **Trade CTA gating:** if fulfill path is canary or book is settlement-only, secondary button style + one-line reason
- **No doom disclaimer** on every pixel—severity matches risk (trade path stricter than browse path)

Your `/market/multichain/known-limitations` page is the backlog; **inline chips + as-of** are what other multi-venue products use so trust scales with honesty instead of collapsing into one red banner.

---

## Unified vision: what "seamless" should mean under your constraints

| Goal | Realistic target | Mechanism |
|------|------------------|-----------|
| Same *UI* everywhere | Yes | One shell, coverage metadata from `venue-registry` |
| Same *data quality* everywhere | No — stop promising it | FBC + source chips + settlement vs book labels |
| Same *safety* for every trade | No until audit | BBRC on all foreign fund-moving paths |
| Free-tier public alpha | Yes | FBC + singleflight + fail closed |
| Close Tensor/BIS/Ordzaar/ORD.NET/OKX gaps by engineering alone | Partially | Tensor settlement scanner + Bitcoin settlement index; accept books that stay gated |

**Highest-leverage build order (no new capital, no approval queue):**

1. **BBRC** on all foreign fulfill/offer paths + legal disclosure that names canary + caps.
2. **FBC** on provider budgets wired into existing singleflight cache.
3. **Tensor on-chain settlement scanner** → activity/realized price with honest labels.
4. **Inline completeness UX** (chips, as-of, trade CTA gating).
5. Optional later: Bitcoin settlement heuristics; SASL only as research.

**Explicit non-goals for alpha:** full OPI, Tensor book parity, Ordzaar API, ORD.NET without 0.01 BTC, OKX before key approval, removing canary caps without audit.

---

### Novelty vs known pattern (summary)

| Proposal | Classification |
|----------|----------------|
| BBRC multi-bucket canary ledger for *foreign marketplace routing* | **Novel synthesis** of capped launch + policy limits |
| Freshness Budget Controller across multi-provider free tiers | **Novel synthesis** of adaptive TTL + budget admission |
| Tensor program-log settlement scanner | **Known pattern** (your HyperSync) applied to Tensor |
| Pure on-chain Ordinals orderbook | **Ruled out** by PSBT off-chain design |
| SASL federated settlement shards | **Novel sketch**, unproven |
| Inline source/freshness chips | **Known UX**, underused in NFT aggregators |

This is the path that gets Marketplank closer to a *credible* unified product without pretending gated walls are engineering bugs or that unaudited routers are safe to open fully.

---

## Synthesized recommendation (Sonnet 5, 2026-08-25)

Grok's response is unusually well-grounded — it didn't just repackage the
brief's own framing back, it correctly separated "novel synthesis" from
"known pattern applied here for the first time" from "ruled out," which
matches this codebase's own evidence discipline. Three things are real
and worth building; one needs a decision from the owner before any code
gets written; one is explicitly R&D, not alpha-path.

**Ready to build now, in this order:**

1. **Tensor on-chain settlement scanner (3a).** This is genuinely the
   highest-leverage, lowest-risk item on the list — it's the exact
   HyperSync pattern already proven for Seaport/Blur/X2Y2/LooksRare,
   applied to a new program ID. No new architecture, no new risk surface,
   no audit dependency (read-only, no trading). This should be the very
   next build.
2. **Freshness Budget Controller (Issue 2).** Concrete, fits the existing
   `singleflight-cache.ts` + Postgres-only constraint exactly as
   designed, and directly answers the HIGH audit finding about rate-limit
   fragility. This slots in as an extension of infrastructure that
   already exists and is already tested.
3. **Inline completeness UX (Issue 4).** Straightforward frontend work on
   top of the `known-limitations` page and `venue-registry.ts` data
   already shipped — source chips + `as_of` timestamps, no backend risk.

**Needs an explicit decision before any code, not a default yes:**

**Bounded Blast-Radius Canary (Issue 1).** This is the one proposal that
changes what real money can do in production. It's a genuinely well-
reasoned interim posture — bounded, quantified, kill-switched, honestly
disclosed — but it is still a decision about how much real user money
this project is willing to put at risk before a real audit, and that's
the owner's call, not an engineering default. Recommend: build the
Postgres ledger + cap-enforcement plumbing now (it's inert until wired
into a live fulfill path), but do NOT connect it to any actual foreign
fulfill/offer function, and do NOT treat "canary caps exist" as
permission to soften the standing "trading is unaudited, don't extend it"
rule — that rule stays in force until this is explicitly discussed.

**Explicitly not alpha-path, correctly flagged by Grok:**

Shard-Attested Settlement Log (3c) and the Bitcoin PSBT off-chain
limitation (3b) are honest dead ends / long-horizon research, not
something to build toward right now. Treat 3c as interesting but out of
scope; treat 3b's conclusion (no pure on-chain Ordinals book is possible)
as final unless new evidence appears.
