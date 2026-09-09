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

## 3. Why this is faster, not just more honest

Speed here is a *consequence* of epistemics, which is the non-obvious part.

**You cannot skip work you cannot prove you already did.** A pipeline re-fetches
because it has no way to know. A proof plane fetches once because content
addressing makes "already done" a decidable question — across processes, across
chains, forever.

**You cannot prioritise work you cannot name.** A blank cell is not schedulable.
A typed hole is. `unsourced` and `underived` are *removed from the queue
permanently*, which is throughput you cannot get any other way — every
competitor is still retrying work that can never succeed.

**You cannot parallelise what you model as a stream.** A chain is a hash-linked
DAG that already exists in its entirety; only the *API* is sequential. Once the
run-list is an interval set (which `collapseRuns`/`holesIn` already were),
ingest shards across N workers and wall-clock scales with **worker count rather
than chain length**. Verified against the real functions: 64 shards in shuffled
order collapse to exactly one run, zero holes — bit-identical to a serial walk.

**Measured, on production:**

| endpoint | before | after |
|---|---|---|
| `/api/market/multichain?limit=40` | **504 @ 60,081 ms** | **0.16 s** |
| `chain-counts` | 8.6 s | 0.32–0.41 s |
| homepage | — | 0.19 s |

`limit=40` is now *faster than* `limit=500` — the correct relationship, and the
proof the sort finally uses an index.

---

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

## 6. Honest position versus the industry

**The order layer is at or above parity** with OpenSea and Blur: criteria bids
against real Seaport Merkle semantics with an independent re-implementation of
on-chain `_verifyProof`; client-side re-derivation of every order before the
wallet prompt; native Bitcoin PSBT listings; 11 chains; published coverage
proofs no competitor exposes.

**What is missing is the retention layer**, and it is not close: no watchlist,
no alerts, no cross-listing, no launchpad, no rewards, no public API.

> A trader could execute a sophisticated trade here today and would have no
> reason to come back tomorrow.

That is a far better problem than the reverse — and it is the honest statement
of where this stands. The architecture above is what makes the *data* worth
returning to. The retention layer is what makes the *person* return.

---

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
