# Marketplank layout mockup

Open `finalized.html` directly in a browser. No build, wallet, API, or chain connection is required.

## What the mockup covers

- All six current market tabs and their existing labels.
- Desktop discovery layout with a filter rail and art-first listing grid.
- Mobile horizontal tabs, filter drawer, two-column grid, and compact market metrics.
- Clickable rarity floor chips, filters, sort controls, vault selection, swap modes, and demo-only wallet actions.
- Wallet-gated states for My NFTs and My Listings.
- Existing RobinWood logo, Plank background, collection artwork, palette, and typography.

## Product intent

The redesign keeps the playful wood-and-gold RobinWood character while giving primary market actions more space and reducing data-panel noise. The mockup is isolated from the runtime application so it can be reviewed before any production component work begins.

## Runtime mapping

| Mockup area | Current component |
| --- | --- |
| Tab rail | `components/market/MarketNav.tsx` |
| Market statistics | `components/market/CollectionStats.tsx` |
| Rarity floor rail | `components/market/RarityFloorStrip.tsx` |
| Filters and sorting | `components/market/FilterBar.tsx`, `components/market/MarketView.tsx` |
| Listing cards | `components/market/ListingCard.tsx`, `components/market/ListingGrid.tsx` |
| Instant Swap | `components/market/InstantVaultSwitcher.tsx`, `components/market/SwapPanel.tsx` |
| Offers | `components/market/IncomingBids.tsx`, `components/market/OfferForm.tsx` |
| Activity | `components/market/ActivityFeed.tsx`, `components/market/VaultTradeHistory.tsx` |
| Portfolio | `components/market/MyNfts.tsx`, `components/market/MyPositions.tsx` |
