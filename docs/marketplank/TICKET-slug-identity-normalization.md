# Ticket: normalize `collection_slug` on write, then drop `lower()` from the read path

**Status: open, deliberately not done in #390.** #390 ships migration 105, an
index matching the query as it exists today. This ticket is the identity fix
that would make 105 optional.

## Why `lower()` cannot simply be deleted today

Measured against production 2026-09-08. `/api/market/multichain/tokens` for
Milady Maker, three casings of the same contract:

| slug | HTTP | tokens | first |
|---|---|---|---|
| `0x5af0d9827e...a425a5` (lower) | 200 | 2 | Milady 0 |
| `0x5AF0D9827E...A425A5` (UPPER) | 200 | 2 | Milady 0 |
| `0x5Af0D9827E...A425a5` (Mixed) | 200 | 2 | Milady 0 |

All three return identical data. `lower()` is load-bearing: the route accepts
any casing a link, a vendor, or a user might produce. Removing the comparison
without first normalizing what is stored would break every non-lowercase URL,
silently, by returning an empty collection rather than an error — the same
failure shape as a 404 page certifying an empty book.

## The real defect underneath

`upsertCollectionTokenProjection` writes `collectionSlug` **raw**:

```
[chainSlug, collectionSlug, chunk.map(...)]
...
ON CONFLICT (chain_slug, collection_slug, token_id) DO UPDATE SET
```

The primary key is case-**sensitive**. So if two indexers ever supply the same
contract in different casings — one from an OpenSea payload, one from a
checksummed address — the same token becomes **two rows**, and a `lower()`
read silently merges them. Nothing errors. Counts inflate.

A normalization rule already exists but lives elsewhere and is not applied
here:

```ts
// lib/market/multichain/archival-ledger.ts
function normalizeCollectionKey(collectionKey: string): string {
  return /^0x[0-9a-f]{40}$/i.test(collectionKey) ? collectionKey.toLowerCase() : collectionKey;
}
```

Note it lowercases **only** EVM-shaped addresses. Bitcoin inscription ids and
Solana mints are case-sensitive identifiers where lowercasing would be wrong —
which is exactly why this needs a deliberate pass rather than a blanket
`.toLowerCase()`.

## The work, in order

1. **Audit.** `SELECT chain_slug, lower(collection_slug), COUNT(DISTINCT collection_slug)
   FROM plank_collection_tokens GROUP BY 1,2 HAVING COUNT(DISTINCT collection_slug) > 1`.
   If that returns nothing, no duplicates exist yet and the rest is prevention.
   If it returns rows, they must be merged before any uniqueness constraint.
2. **Normalize on write**, using the existing EVM-only rule so non-EVM
   identifiers keep their case. One helper, shared by every writer.
3. **Backfill** existing mixed-case rows to the normal form, merging duplicates
   with the same COALESCE precedence the upsert already uses.
4. **Then** the read path can drop `lower()` and the primary key becomes the
   point lookup. Migration 105's index becomes redundant and can be dropped in
   a later migration.

## Do not do step 4 first

Dropping `lower()` before steps 1–3 turns every uppercase or checksummed URL
into an empty collection page. That is worse than the index this ticket would
eventually remove.

## Separately: `/tokens` is a different plan

`/api/market/multichain/tokens` was measured at 34.8s with a 60s timeout, and
also at 0.19s in the same session. Migration 105 will **not** rewrite that
route: it uses `readCollectionTokenProjection`, a keyset walk with a computed
`CASE WHEN token_id ~ '^[0-9]+$' THEN token_id::numeric END` ordering, wide
`traits jsonb` in the select list, and a separate projections-state query.
That needs its own `EXPLAIN ANALYZE` against production-sized data and its own
ticket. Do not attribute any `/tokens` improvement to 105.
