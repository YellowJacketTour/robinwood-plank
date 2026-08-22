# Sync mesh — genesis → every chain, every collection, every cell

This is the constitution for Marketplank global catalog data.  
Code in `lib/market/multichain/mesh/` is source of truth; if this file and the matrix disagree, **fix them together**.

PRs: `base: dev`. Do **not** merge to `master` until bullish0x ships. Hub GET stays snapshot-read. Alchemy NFT API stays off.

## 1. Goal

Continuously fill **sourced** cells (name, image, floor, listed, volume, sales, holders, rarity) for every **identity** we have on every vine chain — Robinhood native included — without:

- inventing a number or JPEG
- stalling all chains when one vendor 403s
- hanging Next (`localhost:3800` / InMotion)
- a single process, key, or cursor owning the night’s work

Empty cell = dash. `0` only when we **counted** an empty book.

## 2. Why one pipeline failed (do not regress)

| Incident | Rule it created |
|---|---|
| Alchemy monthly 429 | Jail that source; never the catalog |
| OS stats all-EVM then 429 | One **lane** = one source × one chain |
| UniSat 403 stopped Bitcoin art | Art has OW + CG when UniSat sleeps |
| CG monthly KV counted list pages | Details-only counters; generation bump (`v3`) if poisoned |
| Hub GET hydrate | Writers are scripts, never App Router |
| Helius mint ≠ ME symbol | Exact identity only; two rows until a real join exists |
| Avax hypersync 3k hex | Catalog ≠ book; rank real books first |
| CG `small` on the hero | Display walks large → fallback; indexer stores best URL |

## 3. Identities (acquire)

A collection is a `(chain_slug, contract_address)`:

| Chain | `contract_address` means |
|---|---|
| EVM + Robinhood | checksum-insensitive `0x` |
| Solana ME | Magic Eden **symbol** |
| Solana Helius | collection **mint** (do not lowercase) |
| Bitcoin UniSat | `collectionId` |
| Bitcoin Ordiscan | Ordiscan **slug** (second catalog, distinct adapter) |

Never collapse two identities with fuzzy names. Dual-write only when a venue proves they are the same id.

## 4. Cells (harness)

Work unit is `(collection, cell)`, not “sync this chain.”

`floor` · `listedCount` · `volume24h` · `sales24h` · `holders` · `name` · `image` · `rarity`

Each cell on each chain has an **ordered source list** in `lib/market/multichain/mesh/matrix.ts`. A jailed source is skipped; the next source runs. If none remain, the cell stays dash and `next_due` backs off.

## 5. Lanes (no single point of failure)

```
mesh-tick
  spawns mesh-lane --source=S --chain=C
    (own process, own jail, own cursor)
```

- Max a few lanes in flight (bounded). Parallelism is **across sources/chains**, not 500 calls on one key.
- Lane exit 0 if the source is jailed (progress, not failure).
- Durable jail: `plank:market:source-jail-until:{source}` in Postgres KV.
- Staleness order: oldest `synced_at` / missing cell first (existing `listCollectionsForSync` + per-spoke cursors).

Hub **express** only reads `plank_multichain_collections` + snapshots.

## 6. Adding a chain or source (future contributions)

1. Add vine in `chain-vines.ts` (`acquire` / `harness` / `express` / `never`).
2. Add lanes in `mesh/matrix.ts` (cell → sources). Exact-match rule in the `notes`.
3. Implement `mesh-lane.ts` arm or reuse an existing runner.
4. Daily ceiling in `source-budget.ts`.
5. One lesson line in `LESSONS-STATS-RARITY-TX.md`.
6. PR against **`dev`**.

Do not add a second mega-script that walks all chains in one Node process.

## 7. Display

`CollectionArtImage` + `imageSrcFallbacks`: largest compatible URL first (CG `/large/`, Seadn `w=2000`, inscription `content`), then fallbacks. Pixel inscriptions use `image-rendering: pixelated`. Titles: full slug/mint if no sourced name.

## 8. Native genesis (RobinWood)

NFT `0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156`, vault V3 `0xacE28f72Fc3e15eA1671e689806694A9b0cE047D`. Native book `getListings("robinwood")` + `plank.love` overlay when local book empty. Hub injects Home. Foreign Instant Swap / Across / 0x stay off.

## 9. Collection page (Milady-quality, every chain)

`lib/market/multichain/collection-surface.ts` is the product contract:

- **Catalog** is the grid (rarity index / ME / OW). Order: token id, or Legendary→Common.
- **Book** overlays Buy/price on matching ids. **Listed only** is the book (price sort).
- Never splice the book as a second list into All items.
- Art extras are chain-specific (`catalogArtExtras`) and proven URLs only.
- Caps: page size / cap / book size on the surface. Load more up to cap. Full 10k is not one request.
- Mesh writers do not DELETE a full catalog to refresh one cell.

## 10. Commands

```
npx tsx --env-file=.env.local scripts/mesh-tick.ts --minutes=12
npx tsx --env-file=.env.local scripts/mesh-lane.ts --source=opensea-stats --chain=opt-mainnet
npm run market:mesh
```

Cron may keep `refresh-market-data.ts`; mesh-tick is the isolator. Site: `START-MARKET.bat`, never hang Next on a lane.
