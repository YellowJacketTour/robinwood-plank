# Handoff for bullish0x + bots — unified catalog / book / mesh

**PR:** merge `feat/hub-honest-cells` → **`dev` only**.  
**Do not merge `dev` → `master`.** Prod is InMotion `plank.tanggang.life` on `master`.  
**Repo:** YellowJacketTour/robinwood-plank.  
**Home:** RobinWood `0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156` on Robinhood 4663. Vault V3 `0xacE28f72Fc3e15eA1671e689806694A9b0cE047D`.  
**Local:** `http://localhost:3800` via `START-MARKET.bat` (never hang Next on a worker).

If this file and code disagree, **fix both**. Code is source of truth.

---

## Why this stack exists

Hub and collection pages were **failing closed into dashes** or **lying** for the same structural reasons:

1. **Discovery outran the book.** Hypersync/Helius/UniSat registered thousands of rows OpenSea/ME cannot price. Empty cell = dash. Inventing floors is forbidden.
2. **One process / one key** walked all EVM then 429’d; OP/BNB never ran. UniSat 403 stopped all Bitcoin art.
3. **Wrong identity.** Solana Helius **mint** ≠ ME **symbol**. Rarity-sorted token **6770** ≠ OpenSea list page **1..50**.
4. **Two grids spliced.** All-items prepended 50 cheapest listings then token 0,1,2 — ranks, prices, and filters disagreed.
5. **Client imported Postgres.** `token-art.ts` → OpenSea → `pg` → `dns` crashed the collection page.
6. **Hi-res helper dropped `/images/plank-logo.webp`.** RobinWood art vanished. Same for `/api/ipfs` and `ipfs://`.
7. **Rarity index returned `imageUrl: null`.** Every indexed collection (Milady) had names, no art. Giant score-ties painted every piece Legendary.
8. **ORB proxy on miladymaker.net** 400’d official PNGs that load as raw `https`.

Fail closed still stands: never invent floors, names, ranks, holders, volume. Alchemy NFT API stays **off**.

---

## How it works now (two layers)

### A. Sync mesh (background)

`docs/marketplank/SPEC-SYNC-MESH.md`  
`lib/market/multichain/mesh/matrix.ts`  
`scripts/mesh-tick.ts` / `mesh-lane.ts`  
`npm run market:mesh`

- **Lane** = one **source × one chain** in its **own process**.
- Durable jail in Postgres KV: UniSat 403 sleeps UniSat; OrdinalsWallet + CG still fill Bitcoin.
- Hub GET is snapshot-read. Writers are scripts, never App Router.
- New chain/source = new lane row, not a second all-chains script.

### B. Collection page (Milady-quality, every vine)

`lib/market/multichain/collection-surface.ts`

| Mode | Feed | Sort |
|---|---|---|
| **Listed only** | Venue book (OS / ME / UniSat / native Seaport) | Price |
| **All items** | Catalog (rarity index) | Token id, or Legendary→Epic→Rare→Uncommon→Common |

The **book overlays** Buy/price on matching catalog ids (`tokenIdAliases`: `6770` / `06770`).  
**Never splice** the book as a second list into All items.

Art: `catalogArtExtras` — proven templates only (Milady CDN live 200; Bitcoin `ordinals.com/content/{inscriptionId}`). Client imports **`token-art-templates.ts` only** (no `dns`).

Caps: page/cap/book on the surface. **Load more** up to cap. Full 10k is not one HTTP payload.

Rarity: −log2 kernel; official RobinWood-style labels must be **exact** (`Legendary`, not substring `rare`). Large score-ties are not all Legendary. Recompute **UPDATE in place** (keep `image_url`). **Do not reindex** when sample already ≥6k.

Filters/floors: counts from the **full** rarity map (~9879 on Milady), not the 400 loaded tiles. Floor chips stay clickable when this book page has 0 of that tier.

---

## Chain sources (exact match only)

| Chain | Catalog | Book | Art |
|---|---|---|---|
| ETH + L2s + BNB + Avax | `plank_foreign_rarity` + OS NFT walk | OpenSea listings | Template if proven, else OS `/nfts/{id}` |
| Solana | Helius rarity else ME list | Magic Eden | ME `token.image`; never lowercase mints |
| Bitcoin | Rarity else OW else UniSat | UniSat | `ordinals.com/content/{id}`, not `/preview` |
| Robinhood | Native rarity + gallery | Seaport + plank.love overlay | `/images/plank-logo.webp` |

CG BNB/Avax = liquid book when OS `/stats` 404s. Monthly counter **v3** details-only (v2 was a false 164k jail).

---

## What bots must not do

- Merge to **master**.
- Re-enable Alchemy NFT API.
- Fuzzy-attach ME symbols to Helius mints.
- `DELETE` a full rarity table to refresh one cell.
- Import `token-art.ts` / `lib/postgres` into a `"use client"` file.
- Proxy hosts that already load as raw images (miladymaker.net).
- Treat Hypersync hex shells as if they had a floor.
- Hang `next dev` on a spoke; use `START-MARKET.bat`.

---

## Verify

```
npm run test:market   # includes mesh-matrix, collection-art, token-art, collection-surface, rarity-lookup, rarity-generic
npx tsx --env-file=.env.local scripts/mesh-tick.ts --chain=robinhood --limit=2
```

Local: `/market/multichain` hub; `/market/multichain/eth-mainnet/0x5af0…` Milady — All items mixed badges; Listed only Buy/price; Rarest first = Legendary at top.

Lessons (append-only): `docs/marketplank/LESSONS-STATS-RARITY-TX.md` (items 1–28).
