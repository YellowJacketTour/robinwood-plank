# Grok findings: organic traffic -> permanent, self-sustaining archive (2026-08-25)

Response to `GROK-RESEARCH-BRIEF-sustainable-archival-mining-2026-08-25.md`.
Preserved verbatim below. See the bottom for the build decision.

---

**Findings: organic traffic -> permanent, self-sustaining archive**

---

## Research answers (with prior art)

### 1. Web archiving at scale (IA / Common Crawl)

**How they decide what to keep**

- Discovery is mostly **link-graph / seeds / centrality**, not "someone just requested this URL." Heritrix follows links; well-linked sites win; seeds used to lean on Alexa, now own + partner data.
- **Save Page Now** is the explicit *demand* path: a human asks -> archive attempts capture. It is secondary to scheduled crawls and often queued, not instant.
- Common Crawl mixes **refresh of known URLs** (~half) with **new discovery**, ranked by harmonic centrality / PageRank-like signals -- breadth over "what one user wanted."
- Academic crawl work stresses **completeness vs popularity** and change/disappearance risk; pure popularity ranking is a poor fit for archival goals.

**Analogy to Marketplank:** Your detail-click + viewport demand is closer to **Save Page Now + popularity bias** than to a full scheduled crawl. IA does *not* treat every organic hit as the primary discovery engine for the whole web; scheduled structure still dominates. Traffic is a **priority and seed signal**, not a substitute for a frontier.

**Classification:** Adapt -- organic demand as high-priority seed; background frontier still required for "no stone unturned."

---

### 2. Citizen science (eBird / iNaturalist)

**What transfers**

- Ordinary activity (birding, hiking) becomes a **permanent scientific archive** when every observation is stored with protocol metadata and quality grades.
- **Quality grades** (Research Grade / Needs ID / Casual) and effort metadata (complete checklist, duration, distance) separate "someone saw something" from "usable for science."
- Absence is only inferable with **complete checklists**; unstructured incidental sightings are weaker.
- Sustained participation works **without pay** when the primary activity is intrinsically valuable (watching birds != filling forms for science).

**Transfer to NFT browsing:** A visit is an **incidental observation** of a collection/token. It is valuable only if the platform then pulls **independently verifiable** facts (on-chain / API), never client-claimed floors. Your fail-closed rule is the analogue of "don't trust the species ID without evidence."

**What does not transfer:** Dual-expert agreement on species ID. You replace that with **source-of-truth reads**, not visitor consensus.

**Classification:** Adapt quality-grade + effort thinking; do not treat visitor intent as truth.

---

### 3. Software Heritage (archive all source, forever)

**Relevant architecture**

- **Append-only Merkle DAG**: content-addressed blobs; intrinsic IDs; dedupe by hash; raw + indexed metadata so bugs in indexers don't destroy facts.
- Mission is explicit completeness aspiration with honest engineering limits (ingest pipelines, copies, legal removal paths).
- "Seen once -> stored forever (if valid)" is the storage contract.

**Transfer:** Your durable tables (metadata, traits, fills) already behave like **content-addressed permanent facts** without a full Merkle DAG. The important lesson is **raw verifiable payload + derived index**, not "visitor said so."

**Classification:** Adopt append-only permanent facts (you largely have this); optional content hashes later.

---

### 4. Blockchain opportunistic discovery

Named public write-ups of "user query discovered contract X before our crawler" are sparse; the pattern is **ad hoc everywhere**: explorers and subgraph hosts warm caches and register entities on first query. Your detail-page + viewport mesh is a deliberate version of that pattern, not an industry-branded protocol.

**Classification:** Genuine recognition of a widespread ad hoc pattern -- worth naming and measuring in-product, not inventing as if it never existed.

---

### 5. Anti-poisoning for organically triggered writes

Prior art (citizen science + archives) agrees:

| Defense | Status in this app |
|---------|-------------------|
| Never trust client-supplied factual claims | Already policy |
| Derive only from on-chain / vendor API | Already |
| Dedupe / idempotent upsert | Already |
| Rate-limit / budget upstream | FBC + mesh + jail |
| Quality grade on rows | Partially (confidence tiers on BTC settlement) |

**Gap worth closing:** A malicious client can still **waste mesh budget** by forcing hydration of junk collection keys. Mitigation is not "trust the visitor less on facts" (facts never come from them) but **admission control on demand**: known registry keys, rate limits, priority floors for unknown keys, fail-closed decode.

**Classification:** Your write path is already correct; harden **demand admission**, not fact authorship.

---

### 6. Completeness modeling for opportunistic archives

IA/Common Crawl/Software Heritage **do not** claim "we have everything." They report holdings, crawl dates, and known gaps. eBird distinguishes complete vs incidental effort.

For Marketplank, the honest split is:

- **Venue coverage** (already): can this venue's *kind* of data be indexed at all?
- **Collection archival score** (new): of the *known* token universe for this collection, how much has ever been successfully hydrated from a real source?

Opportunistic archive => **"coverage of what demand + budget reached"**, never **"coverage of all that exists."**

---

## Honest verdict on "community of sustainable archival miners"

**Mostly already built under another name** -- with one worth-building amplification.

| Claim | Reality today |
|-------|----------------|
| Visitor action -> durable global facts | Yes (token hydrate, fills, listings writes; no TTL on those tables) |
| Visibility -> mesh work for more people | Yes (`prioritizeVisibleCollections` + mesh-tick) |
| Live floors not archived as eternal truth | Yes (FBC / short TTLs) |
| Explicit "archive completeness per collection" | **No** |
| Guaranteed progress on never-visited collections | Only as far as existing background scanners go |
| Public "you are a miner" identity | No (and usually wrong for marketplaces) |

So: the **miner metaphor is rhetoric for a real mechanism you already run**. What is still missing is (1) **measurable archival completeness per collection**, (2) **slightly deeper capture per organic event**, and (3) a **budget-respecting cold-frontier** so traffic-poor collections are not permanently dark -- without pretending organic traffic alone will cover the universe.

---

## Proposed mechanism: **Opportunistic Archival Ledger (OAL)**

### Design principles

1. **Facts are permanent; interest is ephemeral** (already true).
2. **Visitors seed; mesh verifies; Postgres remembers.**
3. **Widen capture per visit** where free APIs allow, without new trust.
4. **Score completeness honestly**; never flip venue `partial` because people scrolled.
5. **Cold frontier** = low-priority background jobs on never-seen keys, still through mesh/FBC.

### A. Widen what one organic event archives (amplification)

On successful `hydrateSpecificToken` / collection hydrate, when budget allows, also enqueue (same mesh, lower than visible priority):

- Sibling tokens in the same collection (bounded batch, e.g. next N ids or rarity neighbors if known).
- Historical fills for that collection **if** a free settlement path exists (you already have lanes).
- Trait/rarity fields you currently skip on the hot path.

**Not:** trusting client trait maps; not unbounded fan-out.

**Classification:** Amplify existing path (highest ROI / effort).

---

### B. Per-collection archival completeness (new, honest metric)

**Schema (Postgres):**

```sql
CREATE TABLE collection_archival_stats (
  chain_slug            text NOT NULL,
  collection_key        text NOT NULL,
  known_supply          bigint,              -- null if unknown
  tokens_ever_hydrated  bigint NOT NULL DEFAULT 0,
  fills_ever_stored     bigint NOT NULL DEFAULT 0,
  first_archived_at     timestamptz,
  last_archived_at      timestamptz,
  organic_hits          bigint NOT NULL DEFAULT 0,
  archival_score        real,                -- 0..1 or null
  score_method          text,                -- 'supply_ratio' | 'hits_only' | 'unknown_supply'
  PRIMARY KEY (chain_slug, collection_key)
);
```

**Score (fail-closed):**

- If `known_supply` is real and > 0:
  `archival_score = least(1, tokens_ever_hydrated / known_supply)`
- Else: `score_method = 'unknown_supply'`, `archival_score = null` -- **do not invent a %**.
- Optional secondary: `fills_ever_stored` as activity depth, not "completeness."

Update on successful hydrate/fill write (idempotent counters).

**UI (optional, quiet):**
"Archive depth: 1,204 tokens stored - supply 10,000" or "Archive depth: 1,204 tokens stored - supply unknown" -- never "100% indexed on OpenSea."

**Classification:** Genuine synthesis for this app (citizen-science effort + Software Heritage permanence + your coverage honesty).

---

### C. Demand admission (anti-poisoning)

In `prioritizeVisibleCollections` / hydrate routes:

- Prefer keys already in registry / discovery tables.
- Unknown keys: allow only at **low priority**, capped per IP/session, and only if decode against real RPC/API succeeds before durable write.
- Never insert permanent rows from client body fields alone.

**Classification:** Adapt production rate-limit + fail-closed norms.

---

### D. Cold frontier (beyond pure organic)

A scheduled low-priority mesh lane:

- Pick collections with `organic_hits = 0` OR `archival_score IS NULL` OR score below threshold.
- One small hydrate batch per tick, under FBC residual budget.
- Explicit job kind: `archival_frontier` so it cannot starve live visibility (priority << VISIBLE).

This is **not** "run scanners more" in the abstract -- it is **score-driven gap fill** aimed at traffic-dark collections. Organic traffic still dominates; frontier prevents permanent blind spots.

**Classification:** Adapt archival pre-crawl prioritization + your mesh; not a new distributed network.

---

### E. Product voice: visible or silent?

| Approach | Precedent | Fit |
|----------|-----------|-----|
| Explicit "you are archiving the chain" | Wikipedia, iNaturalist | Weak for an NFT marketplace audience |
| Silent architecture + quiet depth stats | CDNs, explorers, most indexers | **Stronger** |
| Aggregate counter only | "N new token records stored this week" | Optional, honest, non-gamified |

**Recommendation:** Keep **internal**; optional aggregate or per-collection depth. Do not brand visitors as miners (custody/trust/identity mismatch).

---

### F. Composition with existing stack

```text
Visitor click / viewport
  -> admission control
  -> prioritizeVisibleCollections / hydrateSpecific*
  -> mesh-tick (FBC + source-budget)
  -> real RPC/API
  -> durable upsert (tokens, fills, ...)
  -> collection_archival_stats update
  -> (optional) sibling / history expand jobs

Cold frontier tick
  -> low-priority archival_frontier jobs
  -> same write path + stats
```

Live floors stay short-TTL. Permanent tables stay append-only / upsert-forever.

---

## Build order

1. **Counter updates** on existing hydrate/fill success paths -> `collection_archival_stats`.
2. **Widen organic hydrate** (bounded sibling batch) under budget.
3. **Admission rules** for unknown keys.
4. **Cold frontier** lane in mesh-tick.
5. Quiet UI for archive depth where supply is known.
6. Skip public "miner" branding.

---

## Label summary

| Idea | Label |
|------|--------|
| Permanent facts from verified sources | **Already built** (Software Heritage-like contract) |
| Organic demand -> index work | **Already built** (IA SPN-like + ad hoc explorer pattern) |
| Per-collection archival score | **New synthesis** |
| Bounded expand-on-hydrate | **Amplify existing** |
| Cold frontier by score | **Adapt** archival prioritization |
| Visitor-as-miner product identity | **Not recommended** |
| Client-trusted facts | **Forbidden** (prior art agrees) |

---

### Bottom line

**"Community of sustainable archival miners"** is a vivid name for what this session already implemented: organic attention enqueues real verification work; verified facts stay forever and help everyone.

What is still worth building is not a new trust or custody model, but an **Opportunistic Archival Ledger**: measure how much of each collection's *known* universe has been durably stored, widen each paid-for (in free quota) hydrate a little, and run a **quiet cold frontier** so never-visited collections are not invisible forever -- while venue-level `partial` / `unavailable` labels stay honest and live market state stays non-permanent.

---

## Build decision (Sonnet 5, 2026-08-25)

Real, well-grounded verdict — and it correctly declined to invent theater
where none was needed: the "miner" framing is largely a name for
mechanisms already built today (durable facts, visibility-driven demand).
That's a valuable finding on its own, since it means no big new
architecture is owed here.

**Building now, in the doc's own recommended order, items 1-4 (safe,
scoped, no new trust):**

1. `collection_archival_stats` table + counter updates on existing
   hydrate/fill success paths — the one genuinely new, honest metric this
   session didn't already have.
2. Bounded sibling-token expansion on successful hydrate (amplify, not
   invent).
3. Demand admission hardening (known-registry-key preference, capped
   priority for unknown keys) — directly closes the real gap items 5/6
   in the research identified.
4. A low-priority `archival_frontier` mesh lane for collections with zero
   organic hits — the "no stone unturned" piece that pure organic
   traffic alone can't guarantee.

**Correctly not building**: any public "you are a miner" branding —
Grok's own research (Wikipedia/iNaturalist vs. CDN precedent) concluded
this doesn't fit a marketplace's audience, and that's a product-identity
decision that shouldn't be defaulted into via a backend research brief
anyway.
