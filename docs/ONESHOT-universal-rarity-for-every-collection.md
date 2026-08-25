# One-shot: universal rarity for every collection on every chain

Copy everything below the line into Grok. Do not drop the RobinWood algorithm. Alchemy NFT API is at monthly cap — do not depend on it.

---

You are researching and then specifying a **project-specific rarity + piece-documentation system** for **RobinWood / Marketplank** (`YellowJacketTour/robinwood-plank`, branch `dev`).

## Goal

Every collection on every chain (Ethereum, Base, Polygon, Arbitrum, Optimism, BNB, Avalanche, Solana, Bitcoin Ordinals, Robinhood Chain) must be **as well documented as RobinWood Planks are natively on plank.love**: rank, tier, “rarer than X% of the collection,” per-trait frequency %, floors-by-rarity, criteria bids, details popup analytics. One hyper-intelligent pipeline that **natively adapts** to collection type (721/1155, Ordinals, compressed Solana, 10-item vs 1M supply, trait soup vs official Background-encoded tiers).

Fail closed. Never fabricate ranks, floors, or trait counts.

## What already exists (must reuse, not replace)

### Native RobinWood rarity — `lib/rarity.ts`

This is the canonical plank.love formula. Gallery, ItemDetail, rarity floors, criteria, and listing cards all consume it.

**Canonical traits only (RobinWood metadata schema):** `Base`, `Background`, `Holographic`. Extra traits do not inflate score.

**Score (information content, bits):**  
For each present canonical trait value:  
`traitScore = −log2(count(value) / N)`  
`tokenScore = sum(traitScores)`  
where `N` = currently **revealed/loaded sample**, not necessarily full 1542 until the gallery has indexed everything. Unminted/unloaded tokens are excluded. `informationContent(frequency)` returns 0 if frequency ≤ 0.

**Why −log2 not 1/frequency:** 1/f explodes on 1-of-N traits and drowns everything else. −log2 is standard information content and ranks the same ordinal intent with better spacing.

**Rank:** competition ranking — equal scores share rank `(1,2,2,4)` not `(1,2,3,4)`. Tiebreak: tokenId.

**Two percentiles:**
1. **Score-mass:** share of sample with **strictly lower** score (binary search on sorted scores).
2. **Position:** `((N-1-k)/(N-1))*100` after sort rarest-first.
Display uses `max(scorePercentile, positionPct)` as `percentile` / `normalizedScore` (“outranks %” / rarer than this % of the indexed collection).

**Tier (display):**
- **Primary:** official RobinWood tier is encoded on the **Background** trait (`Legendary`, `Epic`, `Rare`, `RareGraded`, `Uncommon`, `Common`). `tierFromBackground` substring match, longest first (`uncommon` before `common`). `Mythic` coerced to Legendary (never a real Background value).
- **Fallback only** if Background missing: `tierFromPercentile`: ≥95 Legendary, ≥85 Epic, ≥70 Rare, ≥40 Uncommon, else Common.

**UI already wired natively:**
- `ItemDetail.tsx`: rank, tier color, exclusivity %, trait rows with count/%, history.
- `RarityFloorStrip` + `tierFloors`: ALL + per-tier floors vs collection floor, listed counts, tap to filter/sweep.
- `FilterBar`: rarity checkboxes with listed counts; multi-tier OR, price/token AND.
- `ListingCard`: tier badge, glow, holo intensity (`tierHoloIntensity`), floor badge.
- Criteria: `lib/market/trait-criteria.ts` AND clauses; snapshot of token IDs into Seaport Merkle root; `assertAcceptableTraitOffer` on accept.
- Sample honesty: ranks recompute as gallery indexes (`rarityMethodBlurb`).

### Generalized math already in repo — `lib/rarity-generic.ts`

`computeGenericRaritySnapshot(items)` is the **same −log2 / competition rank / position percentile / `tierFromPercentile`** but over **whatever trait types the collection actually has** (not Base/Background/Holo). Used by:
- `lib/market/multichain/rarity-index-runner.ts` (OpenSea `/nfts` pagination, EVM with slug)
- `helius-rarity-index-runner.ts` (Solana)
- `unisat-rarity-index-runner.ts` (Bitcoin — **activity log only**, always `partial: true`, cannot walk 100% of inscriptions)

Stored in `plank_foreign_rarity` + `plank_foreign_rarity_collections.trait_index` (migrations 014/016). Read by `/api/market/multichain/rarity` and `/trait-index`.

**Known gap (why Milady floors show Legendary/Epic “none listed”):** foreign collections only get ranks **after a background index pass**. Hub URLs use **contract address** as `collectionSlug`; indexer historically keyed by **OpenSea slug** — dual-write to both keys was added. Many Avax/ETH harvest shells never get a pass. Alchemy fallback is **forbidden** (monthly 429 jail). Generic tier uses **percentiles only**, so collections with official rarity traits (like RobinWood Background) do not get the Background-primary rule unless we detect that pattern.

### Constraints

- No Alchemy NFT API.
- OpenSea: exact slug only, budgeted.
- CoinGecko NFT: monthly cap already hit this period.
- UniSat: 403 rate limits; Ordinals Wallet catalog for Bitcoin items.
- Fail closed: empty rarity map → un-tiered cards + ALL floor chip from live listings only. Never invent Legendary floors.
- Native `/market` tab rail / DESIGN.md tokens: do not restyle.
- Instant Swap for foreign collections: out of scope.

## Research you must do (global, extensive)

Survey how **production** marketplaces document arbitrary collections:

1. OpenSea rarity (trait counts vs statistical rank).
2. Magic Eden / Tensor rarity and how they handle missing metadata.
3. Blur / Reservoir trait floors.
4. Ordinals: UniSat, Magic Eden BTC, Best in Slot — collection vs inscription attributes.
5. Solana: Helius DAS `getAssetsByGroup`, Metaplex, compressed NFTs.
6. ERC-1155 vs 721; open editions; 1/1; generative 10k; 500k+ (Art Blocks, ENS).
7. How others handle **official on-metadata tiers** vs **computed rank** (RobinWood’s Background rule).
8. Incremental indexing: first page vs full supply; when to mark `partial`.
9. Criteria bids without a complete token-id set (collection wildcard vs Merkle snapshot).

Cite live APIs and honest limits. Prefer keyless or already-configured keys in this repo: OpenSea, Helius, UniSat, Magic Eden, Ordinals Wallet turbo, **not Alchemy**.

## Deliverable

A **RobinWood-specific architecture** (not a generic essay) that:

1. Keeps `informationContent` / competition rank / dual percentile as the **only** scoring kernel.
2. **Adapts trait schema:** detect official tier trait if one exists (Background-like); else score all traits like `rarity-generic`; ignore spam traits (trait count inflation).
3. **Indexes by chain family** without Alchemy: OpenSea nfts for EVM-with-slug; Helius for Solana; UniSat indexer items + OW inscriptions for Bitcoin; never fake coverage.
4. **Keys storage by `chainSlug + contractAddress` (and OS slug alias)** so Milady at `/market/multichain/eth-mainnet/0x...` loads ranks.
5. **UI contract** matching native: floors-by-rarity, sidebar rarity counts, details popup (rank, rarer-than-%, per-trait %), listing card tier, criteria AND + collection-wide wildcard.
6. **Supply scale:** 10 items vs 10k vs 500k — page ceiling, `partial` flag, progressive ranks.
7. **Cron/on-demand:** first collection view may kick a bounded index; never block the page on a full walk.
8. Concrete file list in this repo to change. No fabricated numbers.

End with a phased PR plan against `dev`, fail-closed at every step.
