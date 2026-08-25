# Grok findings: viewport-aware continuous hydration — buildable design (2026-08-25)

Response to `GROK-RESEARCH-BRIEF-viewport-predictive-hydration-2026-08-25.md`.
Preserved verbatim below. See the bottom for the build decision.

---

**Viewport-aware continuous hydration — buildable design**

### Prior art (grounded)

| Idea | Precedent | Takeaway for this app |
|------|-----------|------------------------|
| Viewport → load signal | IntersectionObserver (W3C), AG Grid "init when about to enter view" | Observe rows; don't scroll-listen |
| Batch + idle | Google Quicklink: in-viewport links, `requestIdleCallback`, connection-aware | Batch IDs; don't prefetch on slow/save-data |
| Priority aging | Workable job aging; classic OS aging; queue systems with age boost | Waiting visible collections get priority bumps over time |
| Visible symbols first | Trading terminals: bandwidth goes to on-screen instruments | "What's on screen" outranks fixed background cadence |

This is **attention-driven capacity allocation**, not user surveillance: only collection keys currently (or about to be) rendered in an open tab.

---

## Scope (write this into the module docstring)

**Does:** Make collections that are visible (or predictably next) hydrate **faster / fresher** within FBC + mesh limits: metadata, rarity progress, price freshness, image resolution.

**Does not:** Flip venue-level `coverage: partial` -> `indexed`. OpenSea/Seaport block-0-to-tip proof stays a separate verification project. Demand never invents completeness.

---

## Architecture

```text
Client (GlobalMarketHub / MultichainCollectionView)
  IntersectionObserver + page-context keys
       |  debounced batch POST (<=1 / 2-3s)
       v
POST /api/market/multichain/visibility-demand
       |  validate, cap batch size, expand "likely next"
       v
prioritizeVisibleCollections(chainSlug, keys[], opts)
       |  aging row upsert + priority compute
       v
enqueueDataJob(..., priority)  // existing mesh dedup
       |
       v
Workers that already respect source-budget / jail
Live reads still go through singleflight-cache + freshness-budget
```

Visibility **never** bypasses singleflight or FBC. It only changes **who gets into the mesh queue sooner**.

---

## 1. Signal collection (simplest that covers both surfaces)

**Hybrid:**

| Surface | Signal |
|---------|--------|
| Rankings table (`GlobalMarketHub`) | **Server-known page set** (chain + sort + page/limit already determines the 100 keys) **plus** client IntersectionObserver for the **actually visible subset** (user may only see ~15-25 rows) |
| Detail + related rail / movers strip | **Client-only** IntersectionObserver on those nodes |

**Client pattern (batch, not per-row HTTP):**

```ts
// hooks/useVisibleCollectionDemand.ts
// - data-collection-key on each row/card
// - IntersectionObserver threshold 0.25, rootMargin "100px 0px"
// - accumulate intersecting keys in a Set
// - flush every 2.5s OR on visibilitychange->hidden (final flush)
// - POST { chainSlug, keys: string[], context: "rankings"|"detail"|"rail" }
// - skip if navigator.connection?.saveData or effectiveType is "2g"/"slow-2g" (Quicklink-style)
// - max 40 keys per flush
```

Server also accepts optional `pageKeys` from the rankings route itself (SSR/API already knows the page) so even with JS disabled you still bias the current page, not only the viewport subset.

**Do not** fire one request per row or on every scroll frame.

---

## 2. API route

`app/api/market/multichain/visibility-demand/route.ts`

```ts
// POST body:
// { chainSlug: string, keys: string[], pageKeys?: string[], context?: string }
// - auth: none required (public market); rate-limit by IP + optional session
// - normalize keys, max 40
// - call prioritizeVisibleCollections(chainSlug, mergedKeys, { context })
// - return { accepted: number, enqueued: number }  // no payload data
```

Keep the route thin; all priority logic lives in `collection-demand.ts`.

---

## 3. Demand entry point

Extend `lib/market/multichain/collection-demand.ts`:

```ts
/** Priority bands (higher = more urgent; fits existing 90-100 detail band) */
export const DEMAND_PRIORITY = {
  BACKGROUND: 50,
  DETAIL_PAGE: 95,          // existing single-collection path
  VISIBLE: 110,             // currently intersecting viewport
  VISIBLE_STALE_AGED: 120,  // visible + still stale after aging
  PREDICT_NEXT: 100,        // adjacent rank / related / same family
} as const;

export async function prioritizeVisibleCollections(
  chainSlug: string,
  collectionKeys: string[],
  opts?: {
    context?: "rankings" | "detail" | "rail" | "movers";
    predictNeighbors?: boolean; // default true for rankings
  }
): Promise<{ enqueued: number }>
```

**Behavior:**

1. Dedupe keys; cap at 40.
2. Optional expand (cheap heuristics only):
   - rankings: +/-2 rank neighbors of each visible key if you have rank list in memory/cache
   - detail: related-rail keys already in the POST
   - same-chain only; no collaborative filtering
3. For each key: upsert visibility/aging row; compute priority; call existing `enqueueDataJob` / `prioritizeCollectionDemand` with that priority so **mesh-lane dedup still coalesces**.
4. Jobs requested: membership/stats/rarity/price refresh **only if** your existing job kinds say they're incomplete or past TTL -- don't re-queue pure no-ops.

**Priority relative to today:** detail page stays ~95; pure visible starts **110**; aged visible can reach **120**. Background cadence stays <=50 so attention always wins without starving the mesh (aging + caps prevent permanent lockout).

---

## 4. Postgres: aging / escalation state

```sql
CREATE TABLE IF NOT EXISTS collection_visibility_demand (
  chain_slug        text NOT NULL,
  collection_key    text NOT NULL,
  first_visible_at  timestamptz NOT NULL DEFAULT now(),
  last_visible_at   timestamptz NOT NULL DEFAULT now(),
  visible_hits      int NOT NULL DEFAULT 1,
  last_hydrated_at  timestamptz,
  current_priority  int NOT NULL DEFAULT 110,
  last_enqueued_at  timestamptz,
  PRIMARY KEY (chain_slug, collection_key)
);

CREATE INDEX IF NOT EXISTS collection_visibility_demand_last_visible
  ON collection_visibility_demand (last_visible_at DESC);
```

**Aging schedule** (run inside `prioritizeVisibleCollections` and optionally a 60s tick on workers):

```text
base = VISIBLE (110)
if last_hydrated_at is null OR age(last_hydrated_at) > target_fresh_ttl:
  minutes_waiting = age(last_visible_at) in minutes  // or first_visible_at if never hydrated
  boost = min(10, floor(minutes_waiting / 2))      // +1 every 2 min, cap +10
  priority = min(120, base + boost)
else:
  priority = VISIBLE  // already fresh enough; light touch only
```

On successful hydrate of that collection (wherever jobs complete today), set `last_hydrated_at = now()` and optionally decay `current_priority` back toward 110.

**TTL of rows:** delete or ignore rows with `last_visible_at < now() - interval '2 hours'` so the table stays small.

This is OS-style **aging** applied to a freshness queue (same idea as Workable's priority aging), not a new product category.

---

## 5. Composition with singleflight + FBC (mandatory)

| Path | Rule |
|------|------|
| User-facing GET (floors, collection API) | Unchanged: **singleflight-cache** + **freshness-budget** only |
| Visibility POST | Only enqueues mesh jobs; **no direct upstream provider calls** |
| Mesh workers | Already gated by `source-budget` / `jail`; FBC pressure still widens live TTLs when free-tier QPS is hot |

**Burst control when 100 rows mount at once:**

1. Client sends <=40 keys (visible subset, not full page).
2. Server expands predict-next conservatively (e.g. +10).
3. `enqueueDataJob` dedupes; one job per collection key.
4. Worker pool concurrency unchanged; high priority only orders the queue.
5. If FBC pressure is high, **live** reads return labeled-stale cache; background jobs simply run slower -- visibility does not punch a hole through the budget.

"Many collections become visible at once" is therefore a **queue-ordering** event, not an **N upstream** event.

---

## 6. What "hydrated enough" means (per target)

| Target | Resolves with more demand? | Action |
|--------|----------------------------|--------|
| Price / floor within FBC TTL | Yes | Prefer refresh job if past TTL |
| Metadata / image / rarity index gaps | Yes | Existing membership/rarity job kinds |
| Venue `coverage: partial` (e.g. OpenSea book proof) | **No** | Do not change registry from this path |
| Dead venues (X2Y2) | N/A | primaryVenue fix already excludes them |

Document in `collection-demand.ts` and the visibility route: *visibility demand accelerates fillable gaps; it does not certify protocol-level indexing.*

---

## 7. Predictive "likely next" (keep cheap)

Only these heuristics (no ML):

1. **Viewport** (IntersectionObserver) -- strongest.
2. **Rank adjacency** -- keys immediately above/below visible ranks on current sort.
3. **Detail related rail** -- already on the page; include in the same POST.
4. **Same chain** only.

Skip hover-intent v1 unless you already have hover handlers; Quicklink-style idle + data-saver checks are enough.

---

## 8. Call sites (exact)

| File | Change |
|------|--------|
| `components/market/GlobalMarketHub.tsx` | Mount `useVisibleCollectionDemand({ chainSlug, context: "rankings" })`; mark rows with `data-collection-key` |
| `components/market/MultichainCollectionView.tsx` | Same for main collection + related/movers nodes |
| `app/api/market/multichain/visibility-demand/route.ts` | **New** |
| `lib/market/multichain/collection-demand.ts` | `prioritizeVisibleCollections` + `DEMAND_PRIORITY` |
| Mesh job completion hooks | Touch `last_hydrated_at` when stats/rarity/price jobs finish for that key |
| Rankings SSR/API (optional) | Pass `pageKeys` into the same prioritizer once per page load (priority `PREDICT_NEXT` or soft `VISIBLE`) so first paint page is biased without waiting for IO |

---

## 9. Rate / safety checklist

- Max 40 keys / POST; max 1 POST / 2.5s / tab (client).
- Server IP rate limit (e.g. 30 POSTs / min).
- No PII; only `chainSlug` + public collection keys.
- Ignore unknown keys; never create fake collections.
- `saveData` / slow-2g -> client no-ops.
- Visibility path **cannot** call Helius/Alchemy/OpenSea directly.

---

## 10. Implementation order

1. Table + `prioritizeVisibleCollections` + wire to `enqueueDataJob`.
2. API route + IP limit.
3. Hook + rankings table instrumentation.
4. Detail/related rail.
5. Aging boost + hydrate timestamp updates.
6. Rank adjacency expand.
7. Metrics: queue age for priority>=110, hydrate latency for visible keys, FBC pressure correlation.

---

### One-line product claim (safe)

**"Collections on your screen get first claim on limited free-tier hydration; structural venue gaps stay labeled until separately proven."**

That matches the intelligence-agency-adjacent idea (finite capacity -> focus on what a human is actually looking at) without inventing tracking theater or promising that PARTIAL BOOK chips disappear because someone scrolled past them.

---

## Build decision (Sonnet 5, 2026-08-25)

This is concrete, fully specified, and safe to build now: no new money, no custody, no new user trust, composes correctly with the existing singleflight/FBC infrastructure rather than bypassing it, and has an explicit, honest scope boundary (accelerates fillable gaps, never fakes structural completeness). Proceeding to build per the 6-step implementation order above.
