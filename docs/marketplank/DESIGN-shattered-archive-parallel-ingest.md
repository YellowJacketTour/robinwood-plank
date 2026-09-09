# The Shattered Archive: parallel ingest for total chain coverage

**Status:** design, with the core claims proven against the existing code
**Date:** 2026-09-09

---

## 0. The reframe

Everything shipped so far makes a **serial block-walker** less slow. Walk block
N, parse it, record it, walk N−1. The 60x rate fix, the `ingestRange` branch,
the cursor advance — all correct, all the same shape.

At the improved rate Bitcoin alone is hours. Ten chains from genesis is a
permanent treadmill: the archive never catches up, it only falls behind more
slowly. Adding vendors does not help — they are exhausted or gated, which is
why the hose exists.

**The vendor ceiling is not the wall. Sequence is.**

A blockchain is not a stream. It is a hash-linked DAG that **already exists in
its entirety**. We walk it sequentially because that is the shape of a node's
API — follow `parentHash`. But the *content* has no such dependency: block
800,000 can be parsed with zero knowledge of block 799,999.

Sequence is a property of the interface, not of the data. The problem is
embarrassingly parallel and we have been holding it wrong.

---

## 1. Shatter the chain

Partition `[protocol_t0, tip]` into N shards. Claim them concurrently.

Esplora is **height-addressable** (`/block-height/{n}`), added to the RPC
interface for the leftward backfill. That same primitive makes *any* height
reachable without holding its parent — which is precisely what a serial walk
cannot do.

```
Bitcoin: 198,651 blocks ÷ 64 workers ≈ 3,105 blocks each
```

Wall-clock scales with **worker count**, not with chain length. Hours become
minutes, and a new chain costs workers rather than months.

The archive fills as **islands that merge**, not as an advancing frontier.

### Proven, not assumed

`collapseRuns` and `holesIn` already operate on an interval **set**. Run
against the real functions with 64 shards completing in random order:

```
shards: 64 -> collapsed runs: 1
holes: 0
covers t0..tip: true
COMPLETE (run_count===1): true

with 4 shards missing:
  collapsed runs: 5 | holes: 4
  falsely complete? false
```

Out-of-order arrival converges to an archive **bit-identical** to what the
43-day serial walk would produce. Partial work reports exactly its holes and
refuses to claim completeness.

**The single-span requirement (`run_count = 1`) is the goal state, never a
constraint on how you reach it.** It is exactly the right acceptance test for
parallel ingest: it cannot be fooled by arrival order, and it cannot be fooled
by missing work.

---

## 2. Hash-linking survives — and gets stricter

The serial walker refuses to advance unless the epoch hash-links to the tail
(`backfill.ts`). That guard is the difference between an archive and a pile,
and it must not be traded away for speed.

It isn't. It moves:

- **Within a shard:** the walk verifies linkage as it goes, exactly as today.
- **At every seam:** shard K's lowest block's `parentHash` must equal shard
  K−1's highest block's hash. Verified once, at merge time, in `collapseRuns`.

This is **stricter than the serial walk**. A serial walk verifies each link
once, from one fetch. Sharded merge verifies each link once *and* cross-checks
two **independently fetched** headers agree on the boundary hash — catching a
lying or forked RPC that a serial walk would follow happily, because it has
nothing to disagree with.

A seam that fails to link is not a stall: it enqueues a gap (the existing
`bloom_audit` reason) and every other shard keeps running.

---

## 3. Content-addressed dedup

Ten chains, but EVM chains share bytecode, metadata schemas, and IPFS CIDs
constantly. The same ERC-721 deployed on 8 chains is parsed 8 times today.

**Key work by content hash, not by location.** A CID parsed once is known
everywhere, forever. A bytecode hash seen on Base is not re-analysed on
Arbitrum.

This is already the archive's own doctrine — *objects that authenticate
themselves are canonical from one report; mutable HTTPS never is*. It simply
was never applied to the **work queue**. Applying it there turns
cross-chain redundancy from a cost multiplier into a discount.

---

## 4. Attention as a scheduler, never as a source

The owner's beam, made literal:

> all visitors act as one persistent fingerprint or attention gaze with
> respect to flushing out the entire catalog

Attention does not create a job. **It reprioritises which shard claims next.**
Twenty browsers on one collection raise that shard's priority; they do not
multiply fetches. They raise confidence, and the archive fills fastest exactly
where people are looking while background shards fill everything else.

`attentionMayCreateEdge()` still throws. Attention **schedules**; it never
creates identity. That invariant is untouched.

---

## 5. Why this is buildable now

Every piece of infrastructure already exists:

| need | what exists |
|---|---|
| reach any height without its parent | `getBlockHashAtHeight` (Esplora `/block-height/{n}`) |
| hold non-contiguous coverage | `collapseRuns` / `holesIn` — interval sets |
| concurrent writes, no coordination | `akasha_coverage_run` PK `(chain, from_height)` — one row per shard, idempotent |
| lock-free work distribution | `akasha_gap_queue.claimed_at` + index `(chain, claimed_at, id)` → `SELECT … FOR UPDATE SKIP LOCKED` |
| honest progress metric | `run_count` falling toward 1 |
| refuse premature completeness | `complete_from_protocol` (four clauses, `run_count = 1` load-bearing) |
| seam verification | the `parentHash` check already in `backfill.ts` |

Nothing here needs a new database, a new service, or a vendor. The persistence
layer is **already shard-native** — it was designed for a fragmented archive
that converges, and has simply never been fed in parallel.

---

## 6. Order of work

1. **Shard planner** — split `[t0, tip]` into N ranges, enqueue as claims.
2. **Claiming worker** — `FOR UPDATE SKIP LOCKED`, walk range, verify internal
   linkage, write one coverage run, release.
3. **Seam verifier** — in `collapseRuns`, refuse to merge two runs whose
   boundary hashes disagree; enqueue a gap instead.
4. **Content-hash work key** — dedup parses across chains.
5. **Attention priority** — gaze reorders the claim queue.

Steps 1–3 are the ones that turn 43 days into minutes. Steps 4–5 are what make
it hold across ten chains and keep it aimed at what people are actually
looking at.

---

## 7. What this does not solve

Stated plainly, because the boundary is real and must not be papered over:

**Retrospective omniscience of off-chain state is not a chain property.** An
HTTPS `tokenURI` has no single body. A venue ask is not a fact. Sharding makes
*existence* fast — it does not make a dead IPFS gateway answer, and it does not
turn a vendor's opinion into evidence.

Content-addressed bodies are facts. HTTPS bodies are observations with an age.
Different claim kinds, never merged.

Solana stays deliberately unpinned: the available `programData` slot is ~300
days old against six years of NFT history, so pinning it would silently
discard most of the chain while reporting confident completeness. The throw is
the feature.
