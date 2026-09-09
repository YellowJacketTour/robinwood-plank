# One-shot: finish the Akashic Marketplank

**You are resuming a live production system mid-flight.** Read this whole file
before touching anything. Everything below was measured, not assumed — where a
number appears, it came off the live host on 2026-09-08/09.

---

## 0. The vision, in the owner's words

> every chain, all collections, all marketplace listings, all offers, all
> metadata, all traits, all rarities, all activity, all provenance… near
> instantaneous total akashic record level of archive omnipotence

> the global marketplank is optimized to handle all traffic as an attention
> beam, flushing maximum balance of resources to whichever collection(s) is
> visible on any visitor's screen… all visitors act as one persistent
> fingerprint or attention gaze with respect to flushing out the entire catalog
> with just in time provisions wherever archived data does not already exist

The owner wants **completeness, speed, and invention** — not excuses, and not
vendor-shaped limits accepted as physics. When something blocks you, the
expected response is to invent past it, not to report the block.

**But**: the one boundary that is real and must never be papered over is
*retrospective omniscience of off-chain state is not a chain property*. An
HTTPS `tokenURI` has no single body. A venue ask is not a fact. Say what you
can prove; render a typed hole for the rest. The owner has accepted this
framing explicitly.

---

## 1. Where things actually stand (measured 2026-09-09 01:2x UTC)

**Production**: `plank.love`, auto-deploys on merge to `master`.
Repo `YellowJacketTour/robinwood-plank`. Work happens in the worktree
`C:\tmp\robinwood-sync-fix2`.

**Catalog: 330,185 collections** (was 260,541 at session start).

| chain | count | note |
|---|---|---|
| robinhood | 96,295 | native, healthy |
| eth-mainnet | 51,478 | climbing |
| base-mainnet | 44,356 | climbing |
| bnb-mainnet | 37,777 | climbing |
| solana-mainnet | 30,852 | ~tripled this session |
| **bitcoin-mainnet** | **19,621** | **frozen all session — see §3** |
| arb / avax / polygon / zksync / opt | 15,640 / 12,638 / 11,938 / 4,831 / 4,759 | climbing |

**The akasha hose is LIVE on the production database.** Provisioned under
`flock`, cron observed firing, and — the part that matters — it read its own
tape back after a restart:

```
run 1: restored tape: 0 cursors, 0 headers, 0 events
run 2: restored tape: 1 cursors, 47 headers, 73 events
[hose] bitcoin: locked at 966127, protocol_t0 767430
```

Bitcoin tip at that moment was 966,130. **The archive was 3 blocks behind a
live chain**, having walked 49 blocks and stored 47 headers + 73 real events.
That is the vision working, on your own database, with no vendor.

**Merged to master this session (12 PRs)**: 386–398 except 385. Migrations
104 (akasha tape), 105 (token point-lookup index), 106 (un-curse mall supply).

**Open**: PR #398 (cutover anchor fix, see §4), PR #385 (older Grok brief).

---

## 2. What is already built — do not rebuild it

`packages/akasha` is a complete, tested archive core (114 tests, typecheck
clean). Read `packages/akasha/AUDIT_FOR_OPUS.md` first. It contains:

- **Firehose** (`src/hose/`) — blocks in, events out, coverage as a run-list
- **Identity** (`src/cluster/`) — what counts as one collection
- **Hydrate** (`src/hydrate/`) — what the archive accepts from a visitor
- **Claims** (`src/claims/`) — numbers that carry their own recompute evidence

Four design rules are load-bearing and each has a test that fails if reverted:

1. **Two matching body hashes is NOT confirmation.** IPs are a market. Objects
   that authenticate themselves (CID, envelope, signature) are canonical from
   one report; mutable HTTPS never is.
2. **There is no global floor.** Venue asks are not on-chain.
   `assertTypedFloor` throws on `"floor"`. Publish
   `min_exhibited_valid_order` with the order bytes.
3. **A shared storefront slices.** Collapsing a mall into one collection
   produces a six-digit supply and poisons everything downstream.
4. **Attention schedules work; it never creates identity.**
   `attentionMayCreateEdge()` throws.

The worker ships as `scripts/akasha-hose.ts` → esbuild bundle
`akasha-hose-standalone.mjs`. **The host has no `tsx`** — every always-on
process is a pre-built `.mjs` started by cron under `flock`. A package that is
not bundled cannot run in production, however complete.

---

## 3. Bitcoin is frozen, and you must not "fix" it the obvious way

19,621 across five readings over ~5 hours while every other chain climbed.

**The vendors are the ceiling, not the code.** Measured the same day:

| source | result |
|---|---|
| Ordinals Wallet | not gated, but **exhausted** — 489 real rows at offset 0, **6** at offset 2000; ~1,837 total |
| Ordiscan | HTTP 402 |
| UniSat | HTTP 403 (keyless) |
| Magic Eden | HTTP 503 |
| Hiro | HTTP 410 Gone, deprecated |

No offset tuning produces what the catalog does not have. The dead-zone
constant was already corrected (120,000 → 2,500, PR #387) and that only stops
the lane wasting turns.

**The real path is already proven**: the akasha envelope parser decoded a real
mainnet witness from block 966018 into
`{"p":"brc-20","op":"transfer","amt":"21985295662","tick":"sats"}`. Coherent
JSON out of raw tapscript is proof the keyless path works. `EsploraBitcoinRpc`
reads mempool.space + blockstream.info with failover.

**So: Bitcoin growth comes from the hose walking blocks, not from any catalog.**

---

## 4. The one thing left in flight

`AKASHA_HOSE_OWNS_BITCOIN=1` on the **mesh** cron entry stops four Bitcoin
catalog pagers (`ow-catalog`, `unisat-discovery`, `ordiscan-discovery`,
`unisat-collections`). Ten other Bitcoin lanes keep running, so Bitcoin never
goes dark — only *existence discovery* moves to the hose.

`matrix.ts` reads the flag and matrix runs inside `mesh-tick`. **Setting it on
the hose's own cron line would change nothing while looking like success.**

There is a workflow operation `cutover-bitcoin-existence` with
`arm` / `disarm` / `status`. It has refused three times, each time correctly,
on a bad assumption of mine:

1. `tail -n 200` couldn't see `owning tip for` — the worker's own health lines
   (one ~400-char line/minute) pushed it out of the window. Fixed, PR #397.
2. The sed anchored on `/usr/bin/env UV_THREADPOOL_SIZE=4`, which is what the
   *current* workflow writes — but the live crontab came from an earlier
   provisioning run with a different variable list. Fixed in **PR #398**
   (anchor on `/usr/bin/env`, address-scoped to `mesh-tick-standalone.mjs`).

**Your first task**: land #398, run `status`, then `arm`. The switch prints
the mesh entry before editing now, so a third mismatch will name the line.

---

## 5. The failure species that dominates this codebase

**A miss that reports finished.** Not crashes — crashes page you. These
produce a green CI and a quiet chain. Found this session:

- `SEAPORT_ORDER_FULFILLED` was a wrong keccak sharing its first 18 hex digits
  with the real one. The filter matched nothing; coverage still advanced.
- A reorg fork point matched on *presence in the store* instead of *ancestry*.
  Deleted nothing, kept the orphaned branch, and coverage still claimed it.
- An unguarded genesis walk (a genesis header is its own parent) ran
  5,000,003 steps in 210 ms — **a 2-second wall-clock assertion passed**.
- `assertNoArtifactWrite()` was an empty function body with a comment.
- `assertLegalGap(reason, reason !== "attention_history")` — false for exactly
  the reason requiring it, so that guard could never pass.
- `known_supply` had **two** writers; guarding one and clearing the flag
  *re-enabled* the other, and the value came back larger.
- `resolveOpenSeaCollectionSlug` cached `null` with no TTL — one 429 poisoned
  a collection for the process lifetime.
- A 404 page coerced to `listings: []` then reported `complete: true`.

**House rules that follow:**

> If a miss is indistinguishable from "nothing happened", the test is wrong.

> Always mutation-test a guard: reintroduce the bug, watch the test fail,
> revert. If it doesn't fail, you wrote a mirror, not a check.

> Bound by wall-clock **and** by steps. A fast machine hides an infinite loop.

> Recompute constants from their source definition with a **second**
> implementation. Never eyeball a hash.

Three standing oracles live in `packages/akasha/test/oracles.test.ts`.

---

## 6. My own failure pattern — do not repeat it

I lost roughly ninety minutes to **five instances of one mistake: assuming a
text shape instead of reading it.**

- A test fixture built its input *from the constant under test*, so it moved
  with the bug and passed.
- A `[\s\S]{0,400}` window ran past a `catch` block and matched a later line.
- A `slice(at, at + 7000)` ran past a job boundary into a neighbour's comment.
- `tail -n 200` was outrun by the worker's own logging.
- A sed anchored on today's env-var order, not the stable part of the line.

**Rule: never use a fixed offset where a real boundary exists.** Brace-match,
search for the terminator, normalise line endings first (this repo checks out
**CRLF** — `indexOf("key:\n")` silently finds nothing and every assertion then
fails blaming the wrong file).

---

## 7. The real open problems, ranked

### 7.1 Stride identity (highest value, not started)

Collections are keyed `chain + contract`. Art Blocks / Manifold / Engine /
shared-1155 factories are `chain + contract + project`. Measured on
Friendship Bracelets (`0x942bc2…5c8a`):

```
venue project supply      38,965
archive knownSupply    2,000,335   <- the shared core, 51x
tokensEverHydrated        39,153   <- MORE than the project has
displayed archive depth     1.96%
```

The archive had **already hydrated that project completely** and reported 2%.
Worse: completeness compares `COUNT(*)` against `known_supply`, so a malled
collection's metadata jobs **can never finish** and hold a lane forever.

A guard now refuses a chain supply >2× the venue's (PRs #391/#393), and the
denominator reads `unknown_supply` rather than a wrong percentage. **The
identity fix is not done.** Art Blocks encodes
`tokenId = projectId * 1e6 + invocation`; the right key is
`(chain, contract, stride)` where stride partitions observed ids into dense
bands matching the venue's supply. This is the same failure the cluster layer
already refuses in *host* space, appearing in *token-id* space.

### 7.2 The book fetches orders when the caller wants tokens

Milady Maker: `listedCount 117`, grid shows 2. Not a dedup bug — the
diagnostics proved it:

```
pagesWalked 2   ordersFetched 200   ordersAfterDedup 2   excludedCriteria 0
```

OpenSea sorts cheapest-first and **rotates order hashes** as they near expiry,
so 200 orders are ~100 rotations each of 2 tokens. The walk stops at
`orders >= limit`. **The limit counts orders; the caller cares about tokens.**
Walk until *distinct tokens* reach the target. Measure provider cost first.

I was wrong about this twice — first calling 35 listings "solved", then
blaming criteria orders (`excludedCriteria: 0` disproved it). Do not guess a
third time; the counters are there now, read them.

### 7.3 Viewport hydration is not a work queue

`DEMAND_PRIORITY.VISIBLE = 110` only reorders a collection-wide membership
walk. The 400 rendered cards are not jobs. The invention the owner wants:
on-screen `(tokenId, facet)` holes become the highest band — `tokenURI` +
image for *those ids*, joined to the listing bytes by the same ids. Twenty
browsers on one card must not multiply fetches; they should raise confidence.

### 7.4 Solana is deliberately unpinned

`assertPinnedForCutover("solana")` **throws**. Two routes tried and rejected —
both recorded in `packages/akasha/src/shared/protocol-t0.ts`:

1. `getSignaturesForAddress` pages 1,000 at a time (~22 min of history/page).
2. The programData account **does** carry a slot —
   `PwDiXFxQsGra4sFFTT8r1QWRMd4vfumiWC1jfWNfdYT` decodes to **380,725,176** —
   but that is the **last upgrade**, ~300 days old against a tip of
   445,466,896, while Solana NFTs date from 2020. Pinning it would silently
   discard six years while reporting confident completeness.

**It is easy to obtain, looks authoritative, and is wrong.** Needs an archival
node or an explorer retaining 2020 history. The throw is the feature.

### 7.5 Slug identity

`upsertCollectionTokenProjection` writes the slug raw while `ON CONFLICT` uses
a case-sensitive PK; every read uses `lower()`. Two casings = two rows for one
token, silently merged on read. Migration 105 indexes the `lower()` predicate
as a bandage. `docs/marketplank/TICKET-slug-identity-normalization.md` has the
ordered fix. **Do not drop `lower()` first** — verified live that UPPER and
Mixed casings both return real data, so removing it breaks every checksummed
URL.

---

## 8. Operational facts you will otherwise learn the hard way

- **Master auto-deploys.** Merging *is* deploying.
- **Migrations auto-apply** inside the deploy, after a `pg_dump` that took
  **97 minutes** (the pipeline comment says "40+"). PR #392 dropped compression
  6 → 1 for a 2–4× win. **The backup only runs when a migration is pending** —
  migration-free deploys are fast. **Batch migrations into one deploy.**
- **Deploys queue** (`cancel-in-progress: false`) — merging during a migration
  is safe.
- **`jq` is not on PATH in background shells here.** A monitor using it fails
  silently and reports nothing. Use `awk`/`grep`.
- **The repo checks out CRLF.** See §6.
- Site is fast now: homepage ~0.2 s, chain-counts ~0.3 s, Milady listings went
  **504 @ 60 s → 200 @ 0.37 s** after the archive-read + point-lookup index.

---

## 9. What "done" looks like

Per chain, honestly:

- **Existence**: the hose owns the tip; coverage is one contiguous
  hash-linked run `[protocol_t0, finalized]`. Until then the UI says
  *"complete from block N"*, never *"complete"*.
- **Collections**: every atom the metric minted, plus every foam particle
  attention named — keyed by **stride**, not contract.
- **Listings/offers**: every signed object still `live()`, couriered so it
  survives the venue going dark.
- **Traits/rarity**: content-addressed bodies are facts; HTTPS bodies are
  observations with an age. Different claim kinds, never merged.
- **Provenance**: a hash-linked custody tape a stranger can replay.

The order is fixed: **existence → present-completeness → bandwidth → speech.**
The site currently speaks (names, floors, badges) ahead of the tape. Do not
widen the speech until the tape supports it.

---

## 10. First five moves

1. Land **PR #398**, then `cutover-bitcoin-existence` → `status` → `arm`.
   Verify Bitcoin starts moving off 19,621 within a few hours.
2. Confirm `backfill_tail` walks **left** toward 767,430 and
   `complete_from_protocol` stays **false** until the run-list is one span.
3. **Stride identity** (§7.1). Highest value. Un-freezes malled collections'
   metadata jobs as a side effect.
4. **Token-counting book walk** (§7.2). Read the counters first.
5. **Viewport work queue** (§7.3). This is the attention beam the owner asked
   for and the only item that is genuinely un-built.

Mutation-test every guard. Never let a number appear that nobody can falsify.
