import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { updateVolumeFromMarketEvents, updateCollectionMarketStats, sweepStaleLedgerStats } from "../../lib/market/multichain/store";

const chainSlug = "eth-mainnet";

async function seedEvent(input: { key: string; tx: string; seller: string; buyer: string; wei: string; usd: string | null; venue?: string; hoursAgo: number; currency?: string | null; chain?: string }) {
  await postgresQuery(
    `INSERT INTO plank_market_events (chain_slug, chain_namespace, event_identity, venue_id, protocol, event_type, collection_key, token_id, tx_hash, event_index, sub_index,
        block_timestamp, seller, buyer, currency_address, amount_atomic, amount_usd, finality)
     VALUES ($1, 'eip155', $1 || ':' || $2 || ':' || $3 || ':0:0', $2, 'seaport', 'sale', $4, '1', $3, 0, 0,
        NOW() - ($5::text || ' hours')::interval, $6, $7, $8, $9::numeric, $10::numeric, 'confirmed')
     ON CONFLICT DO NOTHING`,
    [input.chain ?? chainSlug, input.venue ?? "seaport", input.tx, input.key, input.hoursAgo, input.seller, input.buyer, input.currency ?? null, input.wei, input.usd]
  );
}

test("one aggregator: sales/volume/USD per window from the ledger; wash and stream duplicates excluded; vendor writes cannot clobber it", { skip: !hasPostgresConfig() }, async () => {
  const key = `0xzztestagg${Date.now().toString(16)}`;
  const collectionId = (
    await postgresQuery<{ id: number }>(`INSERT INTO plank_multichain_collections (chain_slug, contract_address, adapter) VALUES ($1, $2, 'test') RETURNING id`, [chainSlug, key])
  ).rows[0].id;
  try {
    await postgresQuery(`INSERT INTO plank_multichain_snapshots (collection_id, total_supply) VALUES ($1, 10)`, [collectionId]);
    await seedEvent({ key, tx: `${key}t1`, seller: "0xa", buyer: "0xb", wei: "1000000000000000000", usd: "2500", hoursAgo: 1 });
    await seedEvent({ key, tx: `${key}t2`, seller: "0xc", buyer: "0xd", wei: "2000000000000000000", usd: "5000", hoursAgo: 48 });
    // wash: seller == buyer, must not count
    await seedEvent({ key, tx: `${key}t3`, seller: "0xe", buyer: "0xe", wei: "9000000000000000000", usd: "90000", hoursAgo: 2 });
    // stream duplicate of t1: excluded because plank_seaport_fills holds the tx
    await postgresQuery(
      `INSERT INTO plank_seaport_fills (chain_slug, tx_hash, log_index, block_number, order_hash, seller, buyer, nft_contract, token_id, price_wei, shape)
       VALUES ($1, $2, 0, 1, 'oh', '0xa', '0xb', $3, 1, 1000000000000000000, 'basic') ON CONFLICT DO NOTHING`,
      [chainSlug, `${key}t1`, key]
    );
    await seedEvent({ key, tx: `${key}t1`, seller: "0xa", buyer: "0xb", wei: "1000000000000000000", usd: "2500", venue: "opensea-stream", hoursAgo: 1 });
    // USDC-priced sale counts as a sale and in USD, not in the wei sum
    await seedEvent({ key, tx: `${key}t4`, seller: "0xf", buyer: "0xg", wei: "5000000", usd: "5", currency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", hoursAgo: 3 });
    await seedEvent({ key, tx: `${key}zero`, seller: "0xf", buyer: "0xg", wei: "3000000000000000000", usd: null, currency: "0x0000000000000000000000000000000000000000", hoursAgo: 2 });
    await seedEvent({ key, tx: `${key}wrapped`, seller: "0xf", buyer: "0xg", wei: "4000000000000000000", usd: null, currency: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", hoursAgo: 2 });
    await seedEvent({ key, tx: `${key}future`, seller: "0xf", buyer: "0xg", wei: "99000000000000000000", usd: null, hoursAgo: -2 });
    await seedEvent({ key, tx: `${key}washcase`, seller: "0xABC", buyer: "0xabc", wei: "99000000000000000000", usd: null, hoursAgo: 2 });

    const r = await updateVolumeFromMarketEvents(chainSlug, [key]);
    assert.equal(r.updated, 1);
    const snap = async () => (await postgresQuery<{ sales_24h: number; sales_7d: number; volume_24h_wei: string; volume_24h_usd: string; volume_source: string }>(
      `SELECT sales_24h, sales_7d, volume_24h_wei::text, volume_24h_usd::text, volume_source FROM plank_multichain_snapshots WHERE collection_id = $1`, [collectionId])).rows[0];
    let s = await snap();
    assert.equal(Number(s.sales_24h), 4, "native, zero-address, wrapped and USDC sales; future and wash excluded");
    assert.equal(Number(s.sales_7d), 5);
    assert.equal(s.volume_24h_wei, "8000000000000000000", "native representations included; USDC excluded");
    assert.equal(Number(s.volume_24h_usd), 2505);
    assert.equal(s.volume_source, "ledger");

    // A vendor write while the ledger figure is fresh must not clobber it.
    await updateCollectionMarketStats(chainSlug, key, { volume24hWei: "777", sales24h: 77, currentFloorPriceWei: null });
    s = await snap();
    assert.equal(Number(s.sales_24h), 4, "vendor write ignored while ledger-owned");
    assert.equal(s.volume_source, "ledger");

    // No new event arrives: rolling windows still expire and must be revisited.
    await postgresQuery(`UPDATE plank_market_events SET block_timestamp = NOW() - INTERVAL '31 days' WHERE collection_key = $1`, [key]);
    await postgresQuery(`UPDATE plank_multichain_snapshots SET volume_computed_at = NOW() - INTERVAL '10 minutes' WHERE collection_id = $1`, [collectionId]);
    await sweepStaleLedgerStats(chainSlug);
    s = await snap();
    assert.equal(s.sales_24h, null, "an expired observation cannot remain a current count");
    assert.equal(s.volume_24h_wei, null);
  } finally {
    await postgresQuery(`DELETE FROM plank_market_events WHERE chain_slug = $1 AND lower(collection_key) = $2`, [chainSlug, key]);
    await postgresQuery(`DELETE FROM plank_seaport_fills WHERE chain_slug = $1 AND nft_contract = $2`, [chainSlug, key]);
    await postgresQuery(`DELETE FROM plank_multichain_snapshots WHERE collection_id = $1`, [collectionId]);
    await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id = $1`, [collectionId]);
  }
});

test("case-sensitive collection identities remain separate in rolling aggregation", { skip: !hasPostgresConfig() }, async () => {
  const chain = "solana-mainnet";
  const keys = [`CaseTest${Date.now()}`, `casetest${Date.now()}`];
  const ids: number[] = [];
  try {
    for (const [index, key] of keys.entries()) {
      const id = (await postgresQuery<{id: number}>(`INSERT INTO plank_multichain_collections (chain_slug, contract_address, adapter) VALUES ($1,$2,'test') RETURNING id`, [chain, key])).rows[0].id;
      ids.push(id);
      await postgresQuery(`INSERT INTO plank_multichain_snapshots (collection_id) VALUES ($1)`, [id]);
      await seedEvent({ chain, key, tx: key, seller: "Seller", buyer: "seller", wei: String(index + 1), usd: null, hoursAgo: 1 });
    }
    await updateVolumeFromMarketEvents(chain, keys);
    const rows = await postgresQuery<{volume: string; sales: number}>(`SELECT volume_24h_wei::text AS volume, sales_24h AS sales FROM plank_multichain_snapshots WHERE collection_id = ANY($1::bigint[]) ORDER BY collection_id`, [ids]);
    assert.deepEqual(rows.rows.map(r => [r.volume, Number(r.sales)]), [["1", 1], ["2", 1]]);
  } finally {
    await postgresQuery(`DELETE FROM plank_market_events WHERE chain_slug = $1 AND collection_key = ANY($2::text[])`, [chain, keys]);
    await postgresQuery(`DELETE FROM plank_multichain_snapshots WHERE collection_id = ANY($1::bigint[])`, [ids]);
    await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id = ANY($1::bigint[])`, [ids]);
  }
});
