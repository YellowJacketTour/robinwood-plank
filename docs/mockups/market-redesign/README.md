# Marketplank layout mockup

Open `finalized.html` directly in a browser. No build, wallet, API, or chain connection is required.

## What the mockup covers

- All six current market tabs and their existing labels.
- Desktop discovery layout with a filter rail and art-first listing grid.
- Mobile horizontal tabs, filter drawer, two-column grid, and compact market metrics.
- Clickable rarity floor chips, activity filters, vault selection, five vault modes, and demo-only wallet actions.
- Buy/Sell event, market stats, rarity floors including Common, sweep scopes and presets, and retained Buy/Offer/detail confirmation states.
- Correct vault semantics: Buy is ETH to shares; Redeem is the NFT path. LP, Deposit, V1/V2 migration, pending redeem recovery, odds, price lineage, and the live trade ledger are represented.
- Criteria offer builder with AND clauses, qualifying population, live floor, seller net, single-token offers, and acceptance states.
- Activity analytics with a real SVG sales chart, Sales/Mints/Transfers, evidence-sensitive venues, result count, explorer behavior, and a separate V1/V2 trade ledger.
- Connected and disconnected My NFTs and My Listings states, including send, listing, bid acceptance, cancellation, progress, partial failures, and approval management.
- Existing RobinWood logo, Plank background, collection artwork, palette, and typography.

## Product intent

The redesign keeps the playful wood-and-gold RobinWood character while giving primary market actions more space and using progressive disclosure for advanced operational states. Values are representative prototype fixtures; the runtime implementation continues to source live values, configured addresses, signed order data, and wallet state.

## Runtime mapping

| Mockup area | Current component |
| --- | --- |
| Tab rail | `components/market/MarketNav.tsx` |
| Market statistics | `components/market/CollectionStats.tsx` |
| Rarity floor rail | `components/market/RarityFloorStrip.tsx` |
| Filters and sorting | `components/market/FilterBar.tsx`, `components/market/MarketView.tsx` |
| Listing cards | `components/market/ListingCard.tsx`, `components/market/ListingGrid.tsx` |
| Instant Swap | `components/market/InstantVaultSwitcher.tsx`, `components/market/SwapPanel.tsx`, `components/market/VaultMigrate.tsx`, `components/market/VaultDashboard.tsx`, `components/market/NftPriceChart.tsx`, `components/market/RedeemOdds.tsx` |
| Offers | `components/market/IncomingBids.tsx`, `components/market/OfferForm.tsx` |
| Activity | `components/market/ActivityFeed.tsx`, `components/market/ActivityStats.tsx`, `components/market/VaultTradeHistory.tsx` |
| Portfolio | `components/market/MyNfts.tsx`, `components/market/MyPositions.tsx` |
