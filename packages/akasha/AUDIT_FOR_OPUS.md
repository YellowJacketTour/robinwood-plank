# akasha — audit brief

**Status: draft. Not wired to production. Nothing in this package writes to a
table any running process also writes.** Two writers is worse than the vendor
ceiling, so the cutover is a separate, later decision.

This package is the design answer to a question production could not answer:
*how do you archive every collection on every chain without paying a vendor per
collection, and how does a stranger check that your numbers are right?*

## What is here

| Area | Path | What it decides |
|---|---|---|
| Firehose | `src/hose/` | Blocks in, events out, per-chain coverage runs |
| Identity | `src/cluster/` | What counts as one collection |
| Hydrate | `src/hydrate/` | What the archive accepts from a visitor |
| Claims | `src/claims/` | Numbers that carry the evidence to recompute them |

73 tests pass. `npm test` and `npm run typecheck` are both green.

## The four corrections

Each of these replaced a rule that was unsound. Each has a test that fails if
the old rule comes back.

**1. Two matching hashes is not confirmation.** The superseded design accepted
metadata when two independent visitors reported the same body hash. IP
addresses are a market, so "two browsers" is a rental and a two-browser
attacker could write rarity data the product then badged as fact. The
replacement splits on whether an object can authenticate *itself*. A
content-addressed body verifies against the chain's own commitment, so one
anonymous report is enough and a million dishonest ones are worth nothing.
Mutable HTTPS metadata can never be canonical: it is an observation, promoted
only by a server fetch or by K reports from pairwise-distinct networks spanning
a window. `TWO_HASHES_ARE_NOT_CONFIRMATION()` throws rather than returning
false, so the old rule cannot be reintroduced by someone who skipped the
comment.

**2. There is no global floor.** Production shipped a bare `floorPriceWei`. A
floor is a claim about a *search*, and no such search is possible: venue-held
asks are not on-chain, and Bitcoin has no keyless order book at all. So this
package publishes `min_exhibited_valid_order` with the order bytes attached.
`assertTypedFloor` throws on `"floor"`, `"floorPriceWei"`, and `"price"`. The
test that matters shows the cheapest *valid* order is 100 while a cancelled ask
at 50, an unsigned one at 10, an expired one at 20, and a PSBT at 30 whose
input was already spent are all correctly refused.

**3. A shared storefront must never collapse into one collection.** If OpenSea's
Shared Storefront becomes a single cluster, the archive reports one collection
with a six-digit supply and every downstream number is wrong in a way no later
fix repairs. `detectMall` requires *both* many distinct minters and forking
metadata namespaces, because a popular open-mint collection has many minters
and one namespace and must not slice.

**4. Attention schedules work; it never creates identity.** `attentionMayCreateEdge()`
throws. What a visitor looks at decides what we fetch next and nothing else.

## Two real bugs in the reorg path

`reorg.ts` is the only code here that deletes, and it was untested. Writing
tests for it found two defects, both of which would have reached production.

**An unguarded walk exhausted memory.** A genesis header is its own parent on
several chains, so the loop collecting orphaned blocks asked the store for the
same hash forever and grew its array until `RangeError: Invalid array length`
— about 22 seconds per call. Any malformed parent link does the same. Both
walks are now bounded by a seen-set.

**The fork point was found by presence, not ancestry.** The forward walk
accepted any header already in the store as the common ancestor. But the new
branch's blocks are stored *before* the rewind runs, so it stopped at the new
head's own parent and returned a fork point the old tip never descended from.
Nothing was deleted, and the archive silently kept the orphaned branch while
its coverage still claimed the discarded heights. The candidate is now drawn
only from the old tip's own ancestry.

The second is the more dangerous of the two: it fails silently and leaves the
archive confidently wrong, whereas the first at least crashes.

## A wrong topic hash, which fails silently

`SEAPORT_ORDER_FULFILLED` was
`0x9d9af8e38d66c62e2c12f0225249fd9d721c70b66e27a8da8c70216359c7d2d4`. The real
keccak256 of the event signature is
`...721c54b83f48d9352c97c6cacdcb6f31`. The two share their first 18 hex digits
and diverge after, which is why reading it never catches it.

This is the worst failure mode in the package. A wrong topic does not error:
the log filter never matches, so the chain looks quiet, coverage looks
complete, and the archive reports a healthy empty stream forever. Every
Seaport `OrderFulfilled` log would have been missed.

Topics are now stored beside the event signature they are the hash of, and a
test recomputes all four with a keccak-256 written from scratch in the test
file — deliberately not the library that produced the constants — after first
proving itself against known vectors.

## A guard that could never pass

`GapWorker.step()` called `assertLegalGap(gap.reason, gap.reason !== "attention_history")`.
The second argument means "an artifact genesis exists", but the expression is
false for exactly the one reason that requires it, so every `attention_history`
gap threw and that entire class of backfill was silently dead.

Inverting it to `true` would have been worse: a check that always passes. A gap
now carries the artifact it was opened for and the worker looks it up, so
attention can schedule a backfill for something the archive already holds and
cannot invent a subject — the same rule the cluster layer enforces.

## Two fixes made while writing the tests

Both were found by tests failing honestly rather than by review.

**`uriPrefix` was host-only, which defeated the mall check it fed.** OpenSea's
Shared Storefront serves every unrelated creator from one host and separates
them by path, so a host-only namespace reported "1 prefix" for a mall of
thousands. It now keeps the host plus one path segment for HTTP, while an IPFS
directory CID stays the whole namespace. An ordinary collection serving
`/meta/<id>.json` still reads as one prefix.

**`assertNoArtifactWrite` was an empty function with a comment.** The isolation
boundary it claimed to enforce was not enforced. It now reads the module's own
source and throws on a forbidden import or a writer call, and the test proves
the guard actually fires rather than just passing.

## The envelope parser, checked against mainnet

The tests use synthetic scripts, so the parser was also run against real
Bitcoin. A witness from block 966018 decoded to inscription
`457d87c9…i0`, content type `text/plain;charset=utf-8`, with this body:

```json
{"p":"brc-20","op":"transfer","amt":"21985295662","tick":"sats"}
```

Coherent JSON out of raw tapscript is the proof: random bytes do not decode
into well-formed structure by accident.

This matters because every Bitcoin vendor is now closed. Measured the same day:
Ordiscan returns 402, UniSat 403, Magic Eden 503, and Hiro 410 Gone with a
deprecation notice. The Ordinals Wallet catalog is not gated but is exhausted,
offering roughly 1,837 real collections against the 19,621 already archived.
Keyless block walking is not an optimisation here. It is the only path left.

## Where to attack this

- **`committedDigest` only verifies `sha256://`.** IPFS CIDs return null, and
  null means *reject*, never *trust*. Check that no path treats an unverifiable
  CID as canonical.
- **The ASN quorum assumes distinct `asnHmac` values mean distinct networks.**
  That assumption is the hydrate path's weakest link. The caller derives it.
- **`holders.v1` sorts by `(height, loc)`.** An earlier draft rebuilt events
  with `height: 0`, which resolves the wrong owner for exactly the tokens that
  trade most. `TransferInput.height` is non-optional to prevent it.
- **The envelope parser reads attacker-supplied witness bytes.** Truncated
  pushes, unterminated envelopes, and a 4-byte length as a bomb vector are
  covered, but this is the most hostile surface in the package.
- **Coverage lights the green dot.** If any path can mark a stream alive
  without a contiguous run from `t0` to `finalized`, the completeness claim is
  back to being a liveness signal in disguise.

## What this deliberately does not do

It does not produce truth for unwatched HTTPS-mutable tokens. That is not a gap
to close later; it is the honest boundary. Claiming more would be a lie the UI
would then repeat.
