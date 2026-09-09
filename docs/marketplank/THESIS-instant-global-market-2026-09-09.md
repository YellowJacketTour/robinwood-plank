# The Instant Global Market

**How to be faster than every NFT data provider on earth, by refusing to do
the work they do.**

Written 2026-09-09 from a live pilot of production, signed in through the
backstage door. Every number is measured.

---

## 0. What the pilot found

| measurement | value |
|---|---|
| `/api/market/multichain?limit=500` | 4,934 ms, **698 KB** |
| `/api/market/multichain?limit=40` | **HTTP 504 after 60,081 ms** |
| `chain-counts` | 500 at 11,172 ms, then 200 at 4,560 ms |
| identical repeat request | 4,745 ms (**nothing cached**) |
| rows fetched → cards → images in viewport | **500 → 88 → 12** |
| images still pending after 6 s | **54 of 87** |
| `/api/ipfs/metadata` (homepage) | 10 calls, median **5,651 ms**, 33.4 s total |
| Pinata answering directly | **200 in 4,478 ms** vs our 5,000 ms timeout |

**The smaller page timed out.** That single fact indicts the architecture: work
that ignores its own limit.

---

## 1. The deconstruction: three lies the system tells itself

Every defect found today is one of three category errors. Not thirty bugs —
three.

### Lie 1: "A total is cheap"

`COUNT(*) OVER()` scanned all 345,000 joined rows on every request to print one
label. The limit was applied *after* the count, so asking for less cost more.

**The truth:** a total is a *summary*, not a *fact about this page*.
Pagination never needed it — a short page **is** the last page.

### Lie 2: "Immutable data must be re-fetched"

A CID is the hash of its own bytes. They cannot change. Yet:
`cache: "no-store"` on the fetch, `cf-cache-status: DYNAMIC` on every response,
and a 5,000 ms timeout against a gateway that answers in 4,478 ms.

Correct intent declared in three places, delivering nothing.

**The truth:** a proof is fetched **once, ever, for everyone**. A slow proof is
never a missing proof — the timeout can be generous *because* it happens once.

### Lie 3: "A blank cell is a fact"

80 % of rows had no `holderCount`. 85 % no `listedCount`. 68 % no creator.
All rendered as `—`, which cannot be distinguished from *zero*,
*not yet fetched*, *this collection has none*, or *we failed*.

**The truth:** `—` is the most expensive character on the site. It destroys the
one thing that could fix it — the knowledge of **what is missing**.

---

## 2. The alien assembly: Present Tense

Three primitives. Every ambition in the unified vision falls out of their
combination, and each is already half-built in this repo.

### Primitive I — The Proof Plane (immutable, global, forever)

Anything that hashes to its own name: CID bodies, block headers, finalized
trades, the trait set of a minted token, contract bytecode.

- Keyed by **content**, never by location. The same CID via Pinata, ipfs.io or
  dweb.link is **one** proof — a gateway rotation cannot cause a second fetch.
- Fetched once **across all chains and all visitors**. The same ERC-721 on
  eight chains is one unit of work, not eight.
- Cannot be stale, so it needs no revalidation, no TTL, no cache invalidation
  logic — the hardest problem in caching simply does not arise.

*Built:* `lib/proof-cache.ts`, `packages/akasha/src/hose/workkey.ts`.

### Primitive II — The Observation Plane (mutable, aged, never blank)

Floors, listing counts, holders, venue asks. Someone said so, at a time.

Every observation carries `(value, observedAt, source)` and renders **with its
age**. It is never `—`:

> `floor 0.04 · 3m ago` · `holders — never fetched` · `change — no prior window`

A typed hole is not a failure state. **It is a work order.** The UI stops being
a passive victim of missing data and becomes the queue that fills it.

### Primitive III — The Attention Beam (the scheduler, never a source)

A rendered hole *is* the demand signal. Twenty browsers on one collection raise
that shard's **priority** — they do not multiply fetches; they raise
confidence. A recency floor guarantees unwatched history still fills, so the
archive never degrades into a cache of the popular.

`attentionMayCreateEdge()` and `attentionMayCreateShard()` both throw.
Attention **schedules**; it never invents a subject the chain did not name.

*Built:* `packages/akasha/src/hose/workkey.ts` (`prioritiseShards`).

---

## 3. Why this beats every provider on earth

Incumbents win on *breadth of pre-computation*: they index everything, ahead of
time, and sell the index. That is expensive, always stale at the edges, and
requires trusting their opinion of what is true.

Present Tense wins three different ways at once:

**1. The proof plane makes cold data hot exactly once.**
A provider re-serves the same immutable bytes to every customer forever. We
resolve them once and never pay again — and because proofs are content-keyed,
*cross-chain redundancy becomes a discount rather than a cost multiplier*. Ten
chains sharing an ERC-721 is one fetch, not ten.

**2. The observation plane makes us honest where they guess.**
A provider must show a floor, so it shows a stale one with no age. We show the
age. **A number you can falsify is worth more than a number you must trust** —
and it is the only defensible position for an archive whose stated purpose is
completeness.

**3. The attention beam makes the working set self-selecting.**
A provider pre-computes everything, most of which nobody looks at. We compute
everything eventually (sharding, at worker-count speed) and *what people are
looking at first* — with the same tape and the same guarantees.

The asymmetry: **they pay for breadth up front and staleness forever. We pay
for depth once and freshness only where it is watched.**

---

## 4. The ordered build

Each step is measured against the pilot's own numbers.

1. **Kill `COUNT(*) OVER()`** — 60 s 504 → sub-second. *(shipped)*
2. **Proof-cache IPFS + raise the timeout** — 33.4 s of homepage IPFS → one
   warm read; Pinata's 4.478 s stops being a 500. *(shipped)*
3. **Fix the Cloudflare rule for query-string API URLs.** Config, not code —
   the headers have always been right.
4. **Ask for what is on screen.** 500 rows → 88 cards → 12 visible images is a
   41× amplification. Fetch the viewport, prefetch one screen ahead.
5. **Typed holes everywhere.** Never render `—`. This is what converts 80 %
   missing `holderCount` from a defect into a self-healing queue.
6. **Point the beam at the holes.** The rendered hole becomes the priority
   signal — the owner's "attention gaze" made literal and mechanical.
7. **Turn on sharding** (`AKASHA_SHARD_CLAIMS`) once the RPC budget is known.
8. **Stride identity** — un-freezes BAYC-class rarity and the malled metadata
   lanes.

Steps 1–4 are hours and remove essentially every visible defect in the pilot.
Steps 5–6 are what make the product *feel* alive rather than merely fast.

---

## 5. What must never be "fixed"

The boundary is real, and pretending otherwise would make this an ordinary
provider rather than a better one.

- **Beezie's blank change is correct.** 1,468 sales with no priced native fills
  means no derivable change. Inventing one would be the exact bug the pair
  invariant exists to prevent.
- **`streamAlive: false` is correct** while Bitcoin's past is unwalked. A green
  dot would be a lie.
- **"complete from block 966081", never "complete."** The speech may not run
  ahead of the tape.
- **Retrospective omniscience of off-chain state is not a chain property.** An
  HTTPS `tokenURI` has no single body; a venue ask is not a fact. Content-
  addressed bodies are facts, HTTPS bodies are observations with an age, and
  the two are never merged.

Everything above is an argument for *showing the hole*, not for filling it with
a guess. That discipline is the product.
