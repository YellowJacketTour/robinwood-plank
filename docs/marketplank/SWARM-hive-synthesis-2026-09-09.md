# Swarm synthesis: six dimensions, one product

Six parallel audits — API surface, frontend, data model, competitive gap,
security, architecture — across **181 routes, 173 components, 366 lib modules,
264 tests, 108 migrations, 32 contracts, 58,669 lines of TypeScript.**

Every claim below is from a file that was read or a request that was measured.
Where a bot was wrong, the correction is kept rather than deleted — the
corrections are the most valuable output.

---

## 0. The verdict, before the detail

**This is not an early-stage marketplace with missing features. It is a
technically superior marketplace with a retention layer that does not exist.**

The order layer is at or above parity with OpenSea and Blur: criteria/trait
bids implemented against Seaport's real Merkle semantics with an independent
re-implementation of on-chain `_verifyProof`; sweep with client-side
re-derivation of every order before the wallet prompt; bulk list, bulk cancel,
bundles, NFT↔NFT swaps; native Bitcoin PSBT listings; native Solana
instructions; 11 chains; a multi-venue fill archive with **published coverage
proofs that no competitor exposes**.

What is missing is almost entirely retention and distribution: no watchlist, no
alerts, no cross-listing, no launchpad, no rewards, no public API.

> A trader could execute a sophisticated trade here today and would have no
> reason to come back tomorrow.

That is the whole gap, and it is a much better problem to have than the reverse.

---

## 1. What the swarm corrected about my own findings

Three of my earlier conclusions were wrong. Recording them, because a
correction retained is worth more than a finding asserted.

| my claim | reality | source |
|---|---|---|
| "The hub has no virtualization / lazy images / debounce" | **All three exist.** `GRID_WINDOW_SIZE = 300`, IntersectionObserver with `rootMargin: 1000px`, `loading="lazy"`, 220 ms debounce, and a real skeleton | frontend bot |
| "`force-dynamic` defeats caching" | **It does not.** `lib/http-cache.ts` sets headers manually on the response; they survive. The `cf-cache-status: DYNAMIC` cause is Cloudflare-side and still unidentified | API bot |
| "Branding assets 404" | **All 200.** I probed conventional filenames this app does not use | my own re-check |
| "No wallet support beyond 3 injected providers" | **WalletConnect v2 works** — vendored as a committed 4.86 MB blob, which is why every grep missed it | competitive bot, self-corrected |

The last one is the most instructive: the bot found no `@walletconnect/*` in
`package.json`, concluded "no mobile support at all," then found the vendored
bundle and **withdrew its own headline claim**. The finding got *better* by
getting smaller.

---

## 2. The real top findings, ranked by consequence

### CRITICAL-adjacent: the emergency stop did not stop *(fixed)*

`MARKET_ENABLED` was read in page components only. Across 181 API routes the
sole other reference is `/api/health` echoing it back. With the market "off",
a signed order POSTed to `/api/market/orders` was still verified, accepted and
stored. A curtain, not a stop.

### HIGH: collection identity re-derived ~27 times, most copies wrong *(fixed)*

`store.ts` documents this bug at 2026-08-20 — unconditional lowercasing
corrupted **every Solana row**, confirmed by real `Pubkey Validation Err`
responses. The fix landed in a *private* function, so the rule was re-derived:
two byte-identical private copies of a second, shape-based rule, plus ~25
inline `${chain}:${contract.toLowerCase()}` literals that reintroduce the
original bug.

A corrupted key does not throw. It is a cache miss, an empty lookup, a row
that never joins.

### MEDIUM: `?public=1` bypasses `CRON_SECRET`

`settle-random/route.ts:35` — an unconditional `return true` before the secret
check matters. Anyone can make the server spend `RELAYER_PRIVATE_KEY` gas.
Bounded by an on-chain precondition and a 30/min per-IP limit, so it is **gas
griefing, not theft** — but the relayer has no spend cap. *Not yet fixed.*

### MEDIUM: the sort cannot be indexed, and the count fix did not solve it

The data bot found what I missed. I removed `COUNT(*) OVER()` and reported the
ceiling gone. It found a **second, co-equal ceiling**: the default ORDER BY
spans two tables —

```sql
(c.is_vault_backed) DESC, s.sales_24h DESC, s.sales_7d DESC,
(s.floor_price_wei IS NOT NULL) DESC, s.holder_count DESC, ...
```

Postgres cannot index a sort spanning `collections` and `snapshots`. So every
page load still hash-joins 345 k rows and **sorts all of them** to take 40.
Removing the window count removed one of two full passes.

There is also **no index on `chain_slug`** — the hottest predicate in the app —
and a code comment explicitly rationalises it (*"~115 ms parallel seq scan, no
dedicated index needed at this size"*). That reasoning has a shelf life and it
has expired.

### MEDIUM: the 20-second full-index poll

`setInterval(loadCollections, 20_000)` replaces the entire 698 KB array,
invalidating six `useMemo`s and remounting up to 300 cards **while the user is
reading**. The frontend bot's pick for largest perceived-jank source, and I
would not have found it — I measured load, not steady state.

### MEDIUM: supply chain

`public/wallet-connect-bundle.js` — **4,862,013 bytes, committed, no build
script anywhere.** A WalletConnect security patch cannot be applied without an
undocumented manual process. Verified: `git ls-files` confirms it is tracked;
`package.json` has no matching script.

### LOW-but-alarming: no retention on anything

Across 108 migrations there is **no scheduled pruning of any table**.
`plank_collection_floor_observations` accepts up to one row per collection per
marketplace per minute, with three B-trees per insert and nothing deleting.
That is the outage candidate.

---

## 3. What is genuinely world-class here

Stated plainly because the swarm verified it independently, and because it
should not be lost in a list of defects:

1. **`lib/market/signature.ts`** — recomputes the Seaport 1.6 EIP-712 digest
   from canonical structs, rejects high-s malleable signatures, handles
   EIP-2098 and EIP-1271, checks the on-chain counter, and fails closed on
   every RPC error. The security bot: *"the strongest code in the repo."*
   **No path persists an unverified order.**
2. **Two-sided fee checking** (`assertFeeHonored`) — bounds *both* underpay and
   overpay, preventing a crafted order from siphoning seller proceeds to the
   treasury under the guise of a fee. Most implementations check one side.
3. **Layering is clean.** Zero components importing server-only modules, zero
   lib importing from app, **zero `@ts-ignore` in 58 k lines**, 39 `any` total.
4. **Published coverage proofs.** `isProvenComplete()` refuses to call a cell
   complete without a contiguous indexed range, a `lastSuccessAt` and an
   `evidenceSource` — exposed publicly, including a *known-limitations* page.
   **No competitor publishes its own gaps.**
5. **The venue registry records its own failures honestly** — X2Y2 marked
   `unavailable` with the real HTTP 521 that proved it; Blur marked
   `partial` because it has no public orders API.

---

## 4. The synthesis: three planes, one product

Everything above resolves into the same architecture the live pilot pointed at.

**Proof plane** — content-addressed, fetched once ever, cannot be stale.
CIDs, block headers, finalized trades, minted trait sets. *Cache invalidation,
the hardest problem in caching, does not arise.*

**Observation plane** — `(value, observedAt, source)`, rendered **with its
age**, never blank. Floors, holders, listings, venue asks.

**Attention beam** — a rendered hole **is** the work order. It schedules; it
never invents.

The typed hole is the keystone, and the swarm proved why: the honest
explanations **already exist** (`emptyCellReason`, per chain and per field,
rewritten once to stop promising data the pipeline could not deliver) and are
delivered **exclusively through a `title` attribute** — invisible on touch,
~1 s delayed on desktop, silent to a screen reader.

> The honesty work is done. It simply is not being shown.

`components/market/TypedHole.tsx` makes it visible and gives it four kinds:
`unfetched` (schedulable), `unsourced` (never schedulable), `underived` (needs
time, not a request), `none` (a fact — renders as **0**, not a dash).

Only `unfetched` enters the queue. That single distinction is what turns
"80 % missing" from a defect into a work queue.

---

## 5. The build order

**Now — correctness and trust**
1. ~~Kill switch actually kills~~ *(shipped)*
2. ~~One collection identity~~ *(shipped)*
3. ~~Gate `/api/admin/finance`~~ *(shipped)*
4. Cap `?public=1` and put a wei budget on the relayer
5. Cap the two unbounded store queries and the two uncapped `limit` params

**Next — the speed that makes it feel unreal**
6. Index `chain_slug`; build the `plank_market_hub_rank` summary table so the
   sort stops spanning two tables — *this, not the count, is the real ceiling*
7. Kill or diff the 20 s poll; pause on `document.hidden`
8. `Promise.all` the 27 sequential awaits in `market/multichain/route.ts`
9. Race IPFS gateways with `Promise.any` instead of walking them serially
10. Batch IPFS metadata: one POST instead of 50 GETs

**Then — the product that keeps people**
11. Typed holes everywhere; point the beam at `unfetched`
12. Watchlist, then outbid/floor alerts — *the two cheapest retention features
    in the industry, and both are absent*
13. Cross-listing distribution, then a public API

**Standing**
14. Retention policy on the append-only tables
15. A reproducible wallet-connect build, or Reown AppKit per the existing doc

---

## 6. What must never be "fixed"

- **A blank change on a collection with sales is correct** when the prior
  window holds no priced fill. Inventing one is the exact bug the pair
  invariant prevents.
- **`streamAlive: false`** while a chain's past is unwalked. A green dot is a
  lie.
- **"complete from block N", never "complete."**
- **Retrospective omniscience of off-chain state is not a chain property.**

The discipline *is* the product. Every competitor can buy an index; none of
them can credibly publish where their data ends.
