-- CryptoPunks has a dedicated native-book adapter (contract-native ask
-- scan + CC0 CSV trait hydration, run by the "cryptopunks-native-book" cron
-- step; see lib/market/multichain/native-market-adapters/cryptopunks.ts and
-- NATIVE_BOOK_COLLECTIONS in lib/market/multichain/venue-registry.ts). The
-- row was registered with adapter = 'alchemy-nft', which let the generic
-- per-adapter sync loop (runMultichainSync) and the generic OpenSea rarity
-- scaffold loop (scaffoldAllTrackedCollections) both independently walk and
-- overwrite fields the native adapter already owns -- the same class of bug
-- migration 045 had to patch once already for total_supply. Application code
-- now also skips this collection in both loops via hasUnindexedNativeBook()
-- regardless of the adapter column, but the column itself should say what is
-- actually true: no generic adapter drives this row.
UPDATE plank_multichain_collections
SET adapter = 'cryptopunks-native'
WHERE chain_slug = 'eth-mainnet'
  AND lower(contract_address) = '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb'
  AND adapter <> 'cryptopunks-native';
