-- CryptoPunks is a fixed 10,000-item canonical universe. Aggregator token
-- pagination previously overwrote this with 9,993, so make the durable
-- snapshot agree with the contract-native adapter and canonical dataset.
UPDATE plank_multichain_snapshots s
SET total_supply = 10000, synced_at = NOW()
FROM plank_multichain_collections c
WHERE c.id = s.collection_id
  AND c.chain_slug = 'eth-mainnet'
  AND lower(c.contract_address) = '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb';
