# Live crawl forensics — plank.love, 2026-09-09

Measured in a real browser against production. Every number below came off the
live site or the live API; nothing is inferred.

---

## The single sentence

**Almost every symptom on this site is one bug wearing different clothes: the
archive re-fetches immutable bytes from the public internet on every request,
and then blames the internet when it is slow.**

Content-addressed data — an IPFS CID, a block at a height, a finalized trade —
**cannot change**. Fetching it twice is always waste. The site fetches it
thousands of times, pays a 5-second timeout for the privilege, and renders a
hole when the timeout wins.

---

## 1. The lag, measured

Homepage, cold load:

| endpoint | calls | median | max | total |
|---|---|---|---|---|
| `/api/ipfs/metadata` | 10 | **5,651 ms** | 5,859 ms | **33.4 s** |
| `/api/rpc` | 27 | 408 ms | 678 ms | 11.0 s |
| `/api/market/plank-koth` | 3 | 467 ms | 3,563 ms | 4.3 s |
| `/api/market/orders` | 1 | 1,964 ms | — | 2.0 s |

- **50 API calls to render one page.** DOM ready at 380 ms; load complete at
  2,705 ms; IPFS still resolving long after.
- The 5,651 ms median is not variance. It is `GATEWAY_TIMEOUT_MS = 5_000`
  plus queueing. **Those are timeouts, not errors.**

### The 500s are not the gateway's fault

Ten tokens requested from **one** CID directory. Three returned 200, seven
returned 500 — same directory, same gateway, same instant. A bad CID or a dead
gateway would fail all ten.

Measured directly:

```
gateway.pinata.cloud/ipfs/<cid>/BossPlank.png   ->  200 in 4.478 s
our GATEWAY_TIMEOUT_MS                          ->  5.000 s
```

**Pinata answers in 4.478 s. We hang up at 5 s.** After the per-host token
bucket (`GATEWAY_RATE_PER_SECOND = 8`, burst 8) adds queueing, the tenth
request in a burst crosses 5 s and dies. The art is not missing. We are
0.5 seconds too impatient, on data that never changes.

### The CDN is not caching what the code says is immutable

```
cdn-cache-control: public, max-age=31536000, immutable
cf-cache-status:   DYNAMIC          <-- never cached
```

`/api/ipfs/metadata` **correctly** declares content-addressed data immutable
for a year. Cloudflare stores none of it, because the zone does not cache
query-string URLs. Repeat requests are fast (0.15 s) only when the origin
happens to be warm.

So: the right header, the right intent, and zero benefit. Every visitor pays
the full gateway cost, forever, for bytes that are provably identical.

`lib/ipfs.ts` also passes `cache: "no-store"` on a content-addressed fetch.

---

## 2. Missing data, counted

40 rows, `/api/market/multichain?chain=eth-mainnet&limit=40&sort=volume24h`:

| field | missing | rate |
|---|---|---|
| `holderCount` | 32/40 | **80 %** |
| `listedCount` | 34/40 | **85 %** |
| creator (the ✓ badge) | 27/40 | **68 %** |
| sales > 0 with blank change | 27/40 | **68 %** |
| **change with no sales** | **0/40** | **0 % — invariant holds** |
| images | 0/40 | 0 % |

The pair invariant shipped earlier is confirmed live: **not one phantom
change**. The remaining blanks are a reach problem, not a correctness one.

### Why the blanks cluster

Rows with `holders` and `listed` populated (RobinWood, SolanaBrokers) also
have a change. Rows with **both null** have none. They are the same rows — a
whole class of collection that only ever received a floor.

Beezie is the clean example: **1,468 sales but no 24 h volume**. The ledger
counted trades and holds no priced native fills, so the change derivation
correctly returns null rather than inventing one. **That is the guard working.**

### Traits and rarity: three different failures

| collection | traits | images | rarity | verdict |
|---|---|---|---|---|
| Milady | 24/24 | 24/24 | 24/24 | complete, but **1,447 ms** cold |
| BAYC | 24/24 | 24/24 | **0/24** | rarity never finalized |
| Bitcoin Frogs | 24/24 | **0/24** | 24/24 | no images at all |

BAYC is the `finalizeRarityIfReady` freeze: it gates on `expected_count`, and a
malled or mis-counted denominator means the threshold is never reached.

---

## 3. Wiring and branding

**CORRECTION — my first pass on this was wrong.** I probed conventional
filenames (`/manifest.json`, `/og-image.png`, `/apple-touch-icon.png`) and
reported 404s. This app uses different, correct paths. Verified:

| asset | status |
|---|---|
| `/manifest.webmanifest` (via `app/manifest.ts`) | **200** |
| `/apple-icon.png` | **200** |
| `/plank-social.jpg` (OG + Twitter card) | **200** |
| `/icons/icon-192.png`, `/icons/icon-512.png` | **200** |
| `/images/plank-logo.webp`, `/favicon.ico`, `/robots.txt` | 200 |

`lib/seo.ts` declares `metadataBase`, full `openGraph`, `twitter:
summary_large_image`, and `manifest`. **Branding, PWA and social preview are
complete and correct.** There is nothing to fix here, and reporting otherwise
would have sent someone chasing a bug that does not exist.

**37 failed resources on the market page** — all API, dominated by Pinata
image 500s. No static asset failed.

### RPC

`/api/rpc` returned 500 fifteen times during load ("Could not reach Robinhood
Chain right now"), cascading into a failed V3 vault read. But probed directly,
every method succeeds: `eth_blockNumber`, `eth_chainId`,
`eth_getBlockByNumber`, `eth_call`, `eth_getBalance`, and batches — all 200.

**30 concurrent calls: 0 failures, 976 ms** (vs 123 ms for one). So it is not
raw concurrency. Latency degrades 8× under load and the failures are transient
collisions during the 27-call burst. The chain is healthy; the burst is not.

### Archive

```
bitcoin  tip 966081   runs 21  span 966073 -> 966165
         backfillTail 966081   toProtocolT0 198651   alive false
```

Coverage climbs (8 → 21 runs during the crawl) while the cursor sits at
966081 — the fix is deployed, but the hourly `flock` worker has not yet cycled
onto the new bundle.

**Bitcoin catalog moved: 19,621 → 19,628.** Frozen all session; now growing.

---

## 4. The synthesis: one idea, not fifteen fixes

Every finding above is the same shape. The archive treats **proofs** and
**observations** as the same kind of thing, and re-derives both on demand.

### The invention: a Proof Cache with a typed hole

Split every datum by *what makes it true*, and let that decide its lifetime:

| kind | example | truth source | lifetime |
|---|---|---|---|
| **Proof** | IPFS CID body, block at height, finalized trade, trait set of a minted token | the bytes hash to their own name | **forever** |
| **Observation** | floor price, listing count, holder count, a venue ask | someone said so at a time | **an age, always shown** |

Three consequences follow immediately, and they resolve almost every symptom:

**A. A proof is fetched once, ever — by anyone, for everyone.**
Not per visitor, not per process, not per chain. A CID resolved for Bitcoin
Frogs is resolved for every collection that references it. This is the
content-addressed work key already built in `packages/akasha/src/hose/workkey.ts`,
applied to the *serving* path instead of only the ingest path. The 5 s timeout
stops mattering because the second request never leaves the building.

**B. A slow proof is never a missing proof.**
Pinata at 4.478 s is a *success*. The current design converts it into a 500 and
a blank tile. Under a proof cache, the first visitor waits once and every
subsequent visitor gets it instantly — so the correct timeout is generous
(30 s), not tight, precisely *because* it happens once. Today's tight timeout
is a symptom of paying the cost repeatedly.

**C. An observation renders with its age, and never as a hole.**
`—` is the worst possible cell: it cannot be distinguished from "zero", "not
yet fetched", or "this collection has no floor". Replace every blank with a
typed hole that says which it is:

> `floor 0.04 · 3 m ago` · `holders — never fetched` · `change — no prior window`

The 80 % missing `holderCount` stops being a gap in the product and becomes a
visible, explained, self-healing queue — and the thing that heals it is the
attention beam, which already exists: a rendered hole *is* the demand signal.

### Why this is one change and not fifteen

- IPFS 500s → gone (A + B)
- 33 s of homepage IPFS → one warm read (A)
- Pinata images → gone (B)
- CDN `DYNAMIC` → irrelevant; the origin no longer refetches (A)
- 80 % missing holders → visible, aged, self-healing (C)
- 68 % blank changes → labelled "no prior window", not a bug report (C)
- BAYC rarity → labelled "indexing 34 %", not silence (C)
- Archive depth → already a typed hole (`complete from block N`); this extends
  the same honesty to every other cell on the site

The archive already refuses to lie about **coverage**. This extends the same
discipline to **everything the UI renders** — the rule is already written and
proven in `complete_from_protocol`; it simply has never been applied above the
tape.

---

## 5. Ordered, by value per hour of work

1. **Cache proofs at the edge and in Postgres.** One CID = one fetch, forever.
   Kills the IPFS 500s, the image 500s and 33 s of homepage latency.
   *(Also: raise `GATEWAY_TIMEOUT_MS` — 5,000 ms against a 4,478 ms upstream is
   a self-inflicted failure. It is only safe to raise once (1) is in place.)*
2. **Fix the Cloudflare cache rule for query-string API URLs.** Config, not
   code. The headers are already correct.
3. **Typed holes everywhere.** Never render `—`. Say which hole it is and how
   old the answer would be.
5. **Stride identity.** Un-freezes BAYC-class rarity and the metadata lanes.
6. **Turn on sharding** (`AKASHA_SHARD_CLAIMS`) once the RPC budget is known.

Items 1–3 are hours, not days, and remove roughly every visible defect found in
this crawl.

---

## What must not be "fixed"

- **Blank change on Beezie is correct.** 1,468 sales with no priced native
  fills means no derivable change. Inventing one would be the exact bug the
  pair invariant was built to prevent.
- **`streamAlive: false` is correct.** Bitcoin's past is unwalked; a green dot
  would be a lie.
- **`complete from block 966081`, never "complete".** The speech may not run
  ahead of the tape.
