import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { hasPostgresConfig, postgresQuery, closePostgres } from "../../lib/postgres";
import { GET as tokens } from "../../app/api/market/multichain/tokens/route";
import { GET as rarity } from "../../app/api/market/multichain/rarity/route";
import { readProjectedTokensByIds, writeTokenMetadataResult } from "../../lib/market/multichain/collection-token-store";

test("live projection route and metadata writes isolate case-sensitive collections without enqueuing demand", { skip: !hasPostgresConfig() }, async () => {
  const prefix = `projection-${Date.now()}`;
  const keys = [`${prefix}AbC`, `${prefix}abc`];
  const chain = "bitcoin-mainnet";
  try {
    await postgresQuery(`INSERT INTO plank_collection_token_projections
      (chain_slug, collection_slug, projected_count, partial, source_observed_at)
      SELECT $1, k, 1, TRUE, NOW() FROM UNNEST($2::text[]) k`, [chain, keys]);
    await postgresQuery(`INSERT INTO plank_collection_tokens
      (chain_slug, collection_slug, token_id, name, source_observed_at)
      SELECT $1, k, '1', k, NOW() FROM UNNEST($2::text[]) k`, [chain, keys]);
    await postgresQuery(`INSERT INTO plank_foreign_rarity (chain_slug, collection_slug, token_id, name, score, rank, percentile, tier)
      SELECT $1, k, '1', k, 1, 1, 1, 'Common' FROM UNNEST($2::text[]) k`, [chain, keys]);
    for (const key of keys) {
      const response = await tokens(new NextRequest(`http://localhost/api/market/multichain/tokens?chainSlug=${chain}&collectionSlug=${key}&projection=1`));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.tokens.length, 1);
      assert.equal(body.tokens[0].name, key);
      const byId = await readProjectedTokensByIds(chain, key, ["1"]);
      assert.equal(byId.get("1")?.name, key);
      const rareResponse = await rarity(new NextRequest(`http://localhost/api/market/multichain/rarity?chainSlug=${chain}&collectionSlug=${key}&projection=1`));
      assert.ok([200, 202].includes(rareResponse.status));
      const rareBody = await rareResponse.json();
      assert.equal(rareBody.enqueued, false);
      assert.equal(rareBody.byTokenId["1"].name, key);
    }
    const evmRarity = await rarity(new NextRequest(`http://localhost/api/market/multichain/rarity?chainSlug=eth-mainnet&collectionSlug=${keys[0]}&projection=1`));
    assert.equal((await evmRarity.json()).enqueued, false, "EVM live rarity must not enqueue membership");
    const queued = await postgresQuery("SELECT COUNT(*)::int AS n FROM plank_data_jobs WHERE subject = ANY($1::text[])", [keys]);
    assert.equal(queued.rows[0].n, 0, "live read must not create another hydration cycle");
    await writeTokenMetadataResult({ chainSlug: chain, collectionSlug: keys[0], tokenId: "1", state: "complete" });
    const states = await postgresQuery("SELECT collection_slug, metadata_state FROM plank_collection_tokens WHERE collection_slug = ANY($1::text[])", [keys]);
    assert.equal(states.rows.find((r) => r.collection_slug === keys[0])?.metadata_state, "complete");
    assert.equal(states.rows.find((r) => r.collection_slug === keys[1])?.metadata_state, "pending");
  } finally {
    await postgresQuery("DELETE FROM plank_collection_tokens WHERE collection_slug = ANY($1::text[])", [keys]);
    await postgresQuery("DELETE FROM plank_collection_token_projections WHERE collection_slug = ANY($1::text[])", [keys]);
    await postgresQuery("DELETE FROM plank_foreign_rarity WHERE collection_slug = ANY($1::text[])", [keys]);
    await postgresQuery("DELETE FROM plank_data_jobs WHERE subject = ANY($1::text[])", [keys]);
    await closePostgres();
  }
});
