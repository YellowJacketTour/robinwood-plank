# The Marketplace Stack

**A unified architecture derived from one day of measured failures on a live
345,000-collection multichain marketplace.**

2026-09-09. Every number here came off production or out of the source. Where a
claim could not be verified, it says so.

---

## 0. The thesis in one paragraph

Every marketplace on earth is built as a **pipeline**: fetch from vendors,
store, serve. Its failure mode is structural — a pipeline cannot tell you what
it does not have, so it renders an em-dash and hopes. What this codebase found,
across nine independent bugs in a single day, is that **the em-dash is the
whole disease**. A system that cannot represent *"I do not know, and here is
precisely why"* cannot schedule its own repair, cannot be audited, and cannot
be trusted — and so it accumulates silent lies faster than engineers can find
them. The stack below is the alternative: **every datum carries its own
epistemics**, and the absence of a datum is a *typed, actionable object* rather
than a blank. That single inversion makes the system faster (you only fetch
what you provably lack), more honest (you can publish your own gaps), and
self-healing (a rendered hole *is* the work order).

---

## 1. The nine failures, and the one shape they share

| # | failure | what it looked like | what it was |
|---|---|---|---|
| 1 | `COUNT(*) OVER()` | `limit=40` → **504 @ 60s** | window aggregate over 345k rows *before* LIMIT |
| 2 | cross-table `ORDER BY` | `limit=40` slower than `limit=500` | Postgres cannot index a sort spanning two tables |
| 3 | IPFS re-fetch | 33.4 s of homepage latency, 7/10 → 500 | immutable bytes re-fetched forever; `cf-cache-status: DYNAMIC` |
| 4 | kill switch | flag "off", trades still accepted | `MARKET_ENABLED` gated **pages only** |
| 5 | collection identity | Solana rows unresolvable | `.toLowerCase()` re-derived ~27 times, most wrong |
| 6 | sales ↔ change | 68% blank, some phantom | two derivations from two sources |
| 7 | Bitcoin coverage | `runs=0` on a live tape | `extendCoverage` called from the EVM adapter only |
| 8 | Bitcoin cursor | archive held blocks **above** its own tip | adapter never called `putCursor` |
| 9 | **self-parent lock block** | catalog frozen at 19,628 | boot wrote `parentHash = own hash` |

**Not one of these crashed.** Every one produced a green log, a plausible
number, and a quiet, wrong answer. Six of the nine were *guards that could not
fire* or *work that reported success while doing nothing*.

Failure #9 is the purest specimen and the most instructive. The bridge worked.
The coverage fix worked. The cursor fix worked. All three operated correctly on
a **104-block window** — seventeen hours of Bitcoin — because a placeholder
parent hash meant the backfill could never take its first step. Three correct
systems, composed, produced nothing, and nothing anywhere said so.

> **The lesson: correctness of components does not compose into correctness of
> systems. Only *observability of absence* does.**

---

## 2. The architecture

### Plane I — Proofs (immutable, global, eternal)

Anything that hashes to its own name: an IPFS CID body, a block header, a
finalized trade, the trait set of a minted token, contract bytecode.

- **Content-keyed, never location-keyed.** The same CID via Pinata, ipfs.io or
  dweb.link is *one* proof. A gateway rotation cannot cause a second fetch.
- **Fetched once across all chains and all visitors.** The same ERC-721 on
  eight chains is one unit of work, not eight — cross-chain redundancy becomes
  a *discount* rather than a multiplier.
- **Cache invalidation does not arise.** The hardest problem in caching is
  simply absent, because a proof cannot go stale.

*Built:* `lib/proof-cache.ts`, `packages/akasha/src/hose/workkey.ts`.

**The corollary that matters:** because a proof is fetched once, its timeout
can be *generous*. The 5-second gateway timeout that turned a 4,478 ms success
into a 500 was a symptom of paying the cost repeatedly. **A slow proof must
never be a missing proof.**

### Plane II — Observations (mutable, aged, never blank)

Floors, listing counts, holders, venue asks. Someone said so, at a time.

Every observation carries `(value, observedAt, source)` and renders **with its
age**. It is never `—`. It is one of four kinds:

| kind | meaning | schedulable |
|---|---|---|
| `unfetched` | not looked yet | **yes** |
| `unsourced` | no source exists for this chain | no — trying harder cannot help |
| `underived` | a precondition is missing | no — needs time, not a request |
| `none` | an observed zero | no — it is a **fact**, renders `0` |

`none` is the subtle one and the most valuable. A collection with genuinely
zero listings must show **0**; a dash there is a lie of omission.

Only `unfetched` enters the queue. **That single distinction converts "80%
missing" from a defect into a work queue.**

*Built:* `components/market/TypedHole.tsx`, wired to all seven dash cells.

### Plane III — Attention (the scheduler, never a source)

A rendered hole **is** the demand signal. Twenty browsers on one collection
raise that shard's *priority*; they do not multiply fetches — they raise
confidence.

A **recency floor** guarantees unwatched history still fills, so the archive
never degrades into a cache of the popular. `attentionMayCreateEdge()` and
`attentionMayCreateShard()` both throw: attention **schedules**; it never
invents a subject the chain did not name.

*Built:* `prioritiseShards` in `workkey.ts`.

### Plane IV — Coverage (the tape that can be audited)

Existence is a **hash-linked run-list**, not a high-water mark.
`complete_from_protocol` is true only when four clauses hold, and `run_count = 1`
is the load-bearing one: an archive with holes satisfies every endpoint check
and still cannot claim completeness.

The UI says *"complete from block N"*, never *"complete"*.

**No competitor publishes its own gaps.** This is the defensible asset.

---

## 3. The physics: what actually bounds "everything, instantly"

The goal is not parity. It is the physical limit. So the honest question is:
what *is* the limit, and what is merely an artefact?

### The measured ceiling

```
12 mesh workers x --limit=10  =  120 concurrent slots
PGPOOL_MAX=12, UV_THREADPOOL_SIZE=4, one box
full catalog sweep = 345,000 collections x ~5 facets = ~1.7M jobs
```

**Throughput = slots x (1 / job duration).** That is the whole equation, and
everything else is a rounding error:

| job duration | jobs/hour | full sweep |
|---|---|---|
| 0.3 s | 1,440,000 | **1.2 h** |
| 1.0 s | 432,000 | 4.0 h |
| 3.0 s | 144,000 | 12.0 h |
| 10 s | 43,200 | **39.9 h** |

**A correction I owe, because I got this wrong first.** I argued that per-job
claim transactions were the bottleneck and built batch claiming to fix it. The
arithmetic says coordination is **0.1%–1%** of a job. Batching is worth having
— it removes a table-wide lease-reaper UPDATE per job — but it is a 1% win, and
I nearly shipped it wearing a 20x costume.

**Job duration is the only lever that matters.** A 10-second job needs 33x more
hardware than a 0.3-second one to reach the same place.

### So where does duration actually go?

Measured on production, the dominant component is **waiting on a public gateway
for content-addressed bytes** — a 5,651 ms median with 7 of 10 calls timing out
at 5,000 ms, while the gateway itself answered in 4,478 ms.

That wait is **not physics**. A CID is the hash of its own bytes. Fetching one
twice is always waste, and fetching it a third time across a different chain is
waste squared. The proof plane collapses that class of work to **exactly one
fetch, ever, globally** — which is the difference between the 1.2-hour row and
the 39.9-hour row in the table above.

### The three real limits, once the artefacts are gone

1. **Chain tip rate.** Bitcoin produces a block every ~10 minutes; Ethereum
   every 12 seconds. Forward coverage cannot exceed this and does not need to —
   the archive can be *ahead* of demand.
2. **Historical bytes, once.** ~198,651 Bitcoin blocks of Ordinals history is a
   finite, one-time cost. Sharded across N workers it is `N`-divisible: the
   run-list is an interval set, and 64 shards completing out of order collapse
   to one run with zero holes (verified against the real functions).
3. **Mutable off-chain state.** A venue ask genuinely changes. This is the only
   irreducible recurring cost, and it is bounded by *attention* — you refresh
   what someone is looking at, at the rate they look.

Everything else — re-fetching immutable bytes, re-deriving identity 27 times,
scanning 345k rows to print one integer, retrying work that can never succeed —
is artefact, and every one of those was found and removed this day.

### Why "unthrottled" has one honest exception

Public gateways throttle, and a prior audit in this repo removed gateway racing
*on purpose* after 75 simultaneous requests earned a 30-minute cooldown. I
reintroduced racing this session and CI stopped me.

**The resolution is not to fight the rate limit. It is to stop needing it.** A
proof fetched once needs no race, no retry budget, and no pacing — the second
request never leaves the building. Rate limits bound *how fast you may ask
strangers for things*; they place no bound at all on how fast you serve what
you already possess and can prove.

## 4. The disciplines that make it hold

These are not style preferences. Each was bought with a real failure this day.

**A guard must be provably able to fire.** Bug #4's kill switch, bug #7's
coverage, bug #9's link check — all present, all correct, all unable to act.
Test that the guard *fires*, not that it exists.

**Never bound a source slice by a character count.** Four separate tests this
session failed while the code was correct, because a comment pushed the target
past a fixed offset. Use the next top-level declaration, or strip comments and
assert over the whole file.

**Verify the mutation applied.** One mutation searched for a string whose braces
had already been removed. It matched nothing, changed nothing, and reported a
false pass three times running. *A mutation that applies nothing always passes.*

**Prefer structural invariants to counts.** "X may only ever be read by Y" beats
"X has N readers" — a swap leaves a count unchanged.

**An accelerator must never fail its source.** `refreshHubRank` swallows its own
errors: losing a measured observation to protect a derived index is exactly
backwards.

**A repair must not be a silent no-op.** `putHeader` is `ON CONFLICT DO NOTHING`
— correct for immutable headers, fatal for a repair. The in-memory store would
have updated while the durable row kept the placeholder.

**Distrust your own diagnosis.** Three separate fixes blamed a sed anchor when
the real cause was `diff` unable to run under `bash -s`. The refusal named the
wrong thing three times because a check that *could not run* reported as a check
that *ran and found nothing*.

---

## 5. What this stack refuses to do

The refusals are the product. Anyone can buy an index; nobody else can
credibly publish where their data ends.

- **A blank change on a collection with sales is correct** when the prior window
  holds no priced fill. Inventing one is the bug the pair invariant prevents.
- **`streamAlive: false`** while a chain's past is unwalked. A green dot is a lie.
- **"complete from block N", never "complete."**
- **Solana stays unpinned.** The available `programData` slot is ~300 days old
  against six years of NFT history; pinning it would discard most of the chain
  while reporting confident completeness. *The throw is the feature.*
- **Retrospective omniscience of off-chain state is not a chain property.** An
  HTTPS `tokenURI` has no single body; a venue ask is not a fact. Content-
  addressed bodies are facts, HTTPS bodies are observations with an age, and the
  two are never merged.

---

## 6. The target is the limit, not the leaders

"At or above parity" was the wrong frame, and I used it. Parity is a
settlement. The target is the **physical limit**, and the gap between where
this stands and that limit is measurable rather than rhetorical.

### Where it already exceeds anything shipped

- **Published coverage proofs.** `complete_from_protocol` refuses to claim
  completeness while a single hole exists, and the gaps are exposed publicly.
  No competitor publishes where their data ends, because no competitor can.
- **Client-side re-derivation.** Every swept order is re-validated in the
  buyer's own browser before the wallet prompt; the criteria layer
  re-implements Seaport's on-chain `_verifyProof` independently. Marketplaces
  routinely trust their own relay here. This is the marketplace that *cannot
  lie to you about price*.
- **On-chain-fact identity.** Ordinals collection membership derived from
  envelope tag 3 decoded out of tapscript — a chain fact, not a vendor opinion.
- **Honest venue registry.** X2Y2 recorded `unavailable` with the HTTP 521 that
  proved it; Blur recorded `partial` because it has no public orders API.

### The distance still to run, stated as numbers

| dimension | now | the limit |
|---|---|---|
| Bitcoin historical coverage | 104 blocks | 198,651 blocks (one-time, shardable) |
| full-catalog sweep | ~40 h at 10 s/job | **~1.2 h** at 0.3 s/job |
| ingest parallelism | 1 serial walker | N shards, `N`-divisible |
| retention layer | **absent** | watchlist, alerts, cross-listing, rewards, public API |

The first three are engineering with a known answer. The fourth is the one
that decides whether anyone is there to see it:

> A trader could execute a sophisticated trade here today and would have no
> reason to come back tomorrow.

That is not a small caveat. **A superior engine with no retention layer is a
demo.** The architecture above is what makes the data worth returning to; the
retention layer is what makes the person return. Both are required, and only
one of them is built.

## 7. The build order from here

1. **Verify the self-parent fix unsticks the backfill.** Everything Bitcoin
   depends on it. If `blocksToProtocolT0` does not start falling, that is the
   next investigation, not a footnote.
2. **Turn on sharding** (`AKASHA_SHARD_CLAIMS`) once the RPC budget is known —
   hours instead of 43 days.
3. **Point the beam at `unfetched` holes.** The scheduler half of Plane III.
4. **Stride identity** — un-freezes malled rarity and metadata lanes.
5. **Watchlist, then outbid/floor alerts.** The two cheapest retention features
   in the industry, and both absent.
6. **Consolidate the ~27 identity derivations** onto `collection-key.ts`, and
   the six cache mechanisms onto the proof/observation split.

Items 1–2 finish the archive. Items 5–6 are what turn a superior engine into a
product people come back to.
