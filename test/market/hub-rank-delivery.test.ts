import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { hasPostgresConfig, postgresPool, closePostgres } from "../../lib/postgres";

test("discovery and all snapshot writes maintain the browsing index transactionally", { skip: !hasPostgresConfig() }, async () => {
  const client = new Client(postgresPool().options);
  await client.connect();
  try {
    await client.query("BEGIN");
    const key = `rank-delivery-${Date.now()}`;
    const result = await client.query(`INSERT INTO plank_multichain_collections(chain_slug,contract_address,adapter)
      SELECT 'solana-mainnet', $1 || n::text, 'test' FROM generate_series(1,3) n RETURNING id`, [key]);
    const ids = result.rows.map(row => row.id);
    const rank = async () => (await client.query(`SELECT floor_price_wei::text, has_floor, listed_count, is_vault_backed
      FROM plank_market_hub_rank WHERE collection_id = ANY($1::bigint[]) ORDER BY collection_id`, [ids])).rows;
    assert.equal((await rank()).length, 3, "all artless discoveries are browseable before statistics");
    assert.ok((await rank()).every(row => row.floor_price_wei === null && !row.has_floor));
    await client.query(`UPDATE plank_multichain_collections SET is_vault_backed=true WHERE id=ANY($1::bigint[])`, [ids]);
    assert.ok((await rank()).every(row => row.is_vault_backed), "collection changes refresh rank keys");
    await client.query("SAVEPOINT snapshots");
    await client.query(`INSERT INTO plank_multichain_snapshots(collection_id,floor_price_wei,listed_count)
      SELECT unnest($1::bigint[]), 100, 1`, [ids]);
    assert.ok((await rank()).every(row => row.floor_price_wei === "100" && row.has_floor));
    await client.query(`UPDATE plank_multichain_snapshots SET floor_price_wei=200, listed_count=2 WHERE collection_id=ANY($1::bigint[])`, [ids]);
    assert.ok((await rank()).every(row => row.floor_price_wei === "200" && row.listed_count === 2));
    await client.query(`DELETE FROM plank_multichain_snapshots WHERE collection_id=ANY($1::bigint[])`, [ids]);
    assert.ok((await rank()).every(row => row.floor_price_wei === null && !row.has_floor));
    await client.query("ROLLBACK TO SAVEPOINT snapshots");
    assert.ok((await rank()).every(row => row.floor_price_wei === null));
    await client.query("ROLLBACK");
    assert.equal((await rank()).length, 0, "rolled-back discoveries leave no browsing rows");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
    await closePostgres();
  }
});
