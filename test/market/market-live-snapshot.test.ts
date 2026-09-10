import assert from "node:assert/strict";
import test from "node:test";
import {NextRequest} from "next/server";
import {GET} from "../../app/api/market/multichain/changes/snapshot/route";
import {hasPostgresConfig, postgresQuery, closePostgres} from "../../lib/postgres";

test("live snapshot delivers exact multi-window statistics and preserves chain identity", {skip: !hasPostgresConfig()}, async () => {
  const address = `0x${Date.now().toString(16).padStart(40, 'a')}`;
  const solana = `SnapshotCase${Date.now()}`;
  const ids: string[] = [];
  try {
    for (const [chain,key] of [["eth-mainnet",address],["solana-mainnet",solana]]) {
      ids.push((await postgresQuery<{id: string}>("INSERT INTO plank_multichain_collections(chain_slug,contract_address,adapter) VALUES ($1,$2,'test') RETURNING id::text", [chain,key])).rows[0]!.id);
    }
    await postgresQuery(`INSERT INTO plank_multichain_snapshots(collection_id,volume_24h_wei,sales_24h,volume_7d_wei,sales_7d,volume_30d_wei,sales_30d,floor_change_pct)
      SELECT unnest($1::bigint[]),123456789012345678901,3,223456789012345678901,7,323456789012345678901,30,12.5`, [ids]);
    const scopes = [{chainSlug: "eth-mainnet",collectionKey: address.toUpperCase().replace('0X','0x')},
      {chainSlug: "solana-mainnet",collectionKey: solana}, {chainSlug: "solana-mainnet",collectionKey: solana.toLowerCase()}];
    const response = await GET(new NextRequest(`http://localhost/api/market/multichain/changes/snapshot?scopes=${encodeURIComponent(JSON.stringify(scopes))}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.returned, 2, "EVM identity normalizes; a different-case Solana key does not match");
    for (const row of body.collections) {
      assert.equal(row.volume24hWei, "123456789012345678901");
      assert.equal(row.volume7dWei, "223456789012345678901");
      assert.equal(row.volume30dWei, "323456789012345678901");
      assert.deepEqual([row.sales24h,row.sales7d,row.sales30d,row.floorChangePct],[3,7,30,12.5]);
    }
  } finally {
    await postgresQuery("DELETE FROM plank_multichain_collections WHERE id=ANY($1::bigint[])", [ids]);
    await closePostgres();
  }
});


test("native ledger projection cannot be erased by a generic discovery snapshot", {skip: !hasPostgresConfig()}, async () => {
  const { NFT_CONTRACT_ADDRESS } = await import("../../lib/mint-contract");
  const { salesStatsFromLedger } = await import("../../lib/market/chain-events");
  let inserted: string | undefined;
  try {
    inserted = (await postgresQuery<{id: string}>(`INSERT INTO plank_multichain_collections(chain_slug,contract_address,adapter)
      VALUES ('robinhood',$1,'test') ON CONFLICT (chain_slug,contract_address) DO NOTHING RETURNING id::text`, [NFT_CONTRACT_ADDRESS.toLowerCase()])).rows[0]?.id;
    const expected = await salesStatsFromLedger();
    const scopes = [{chainSlug: "robinhood", collectionKey: NFT_CONTRACT_ADDRESS}];
    const response = await GET(new NextRequest(`http://localhost/api/market/multichain/changes/snapshot?scopes=${encodeURIComponent(JSON.stringify(scopes))}`));
    const row = (await response.json()).collections[0];
    assert.equal(row.sales24h, expected.sales24h);
    assert.equal(row.volume24hWei, expected.volume24hWei);
    for (const field of ["floorPriceWei", "listedCount", "holderCount", "totalSupply", "floorChangePct", "name", "imageUrl"]) {
      assert.equal(Object.hasOwn(row, field), false, `generic projection does not own ${field}`);
    }
  } finally {
    if (inserted) await postgresQuery("DELETE FROM plank_multichain_collections WHERE id=$1", [inserted]);
    await closePostgres();
  }
});
