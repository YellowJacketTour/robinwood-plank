import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { hydrationJobSources } from "../../lib/market/multichain/collection-demand";

/**
 * Real gap found live 2026-08-27 (same audit that found the CloneX/EVM
 * count-completion gap): Bitcoin (unisat-membership) and Solana
 * (helius-membership) never got the same source-agnostic real-row-count-
 * vs-total_supply cross-check EVM chains did -- each source's own
 * `complete` flag only ever reflects ITS OWN pagination reaching its own
 * end, blind to the real aggregate already being fully populated by any
 * combination of sources. Proves hydrationJobSources now drops the
 * membership source once real rows reach the real known total_supply, on
 * both non-EVM chains, the same way it already does for EVM.
 */
async function seedCollection(chainSlug: string, address: string, totalSupply: number) {
  const inserted = await postgresQuery<{ id: number }>(
    `INSERT INTO plank_multichain_collections (chain_slug, contract_address, adapter)
     VALUES ($1, $2, 'test') RETURNING id`,
    [chainSlug, address]
  );
  const collectionId = inserted.rows[0].id;
  await postgresQuery(`INSERT INTO plank_multichain_snapshots (collection_id, total_supply) VALUES ($1, $2)`, [collectionId, totalSupply]);
  return collectionId;
}

async function seedTokens(chainSlug: string, address: string, count: number) {
  for (let i = 0; i < count; i++) {
    await postgresQuery(
      `INSERT INTO plank_collection_tokens (chain_slug, collection_slug, token_id, source_observed_at) VALUES ($1, $2, $3, NOW())`,
      [chainSlug, address, String(i)]
    );
  }
}

async function cleanup(chainSlug: string, address: string, collectionId: number) {
  await postgresQuery(`DELETE FROM plank_collection_tokens WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`, [chainSlug, address]);
  await postgresQuery(`DELETE FROM plank_multichain_snapshots WHERE collection_id = $1`, [collectionId]);
  await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id = $1`, [collectionId]);
}

test(
  "hydrationJobSources drops unisat-membership (Bitcoin) once real rows reach total_supply, even with no per-source complete flag",
  { skip: !hasPostgresConfig() },
  async () => {
    const address = `test-btc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const chainSlug = "bitcoin-mainnet";
    const collectionId = await seedCollection(chainSlug, address, 2);
    try {
      let sources = (await hydrationJobSources(chainSlug, address)).map((s) => s.source);
      assert.ok(sources.includes("unisat-membership"), "0 of 2 real rows must still enqueue membership");

      await seedTokens(chainSlug, address, 2);
      sources = (await hydrationJobSources(chainSlug, address)).map((s) => s.source);
      assert.ok(!sources.includes("unisat-membership"), "2 of 2 real rows must drop membership regardless of any per-source flag");
      assert.ok(sources.includes("unisat-rarity"), "rarity has no completion gate and must remain unconditional");
    } finally {
      await cleanup(chainSlug, address, collectionId);
    }
  }
);

test(
  "hydrationJobSources drops helius-membership (Solana) once real rows reach total_supply, even with no per-source complete flag",
  { skip: !hasPostgresConfig() },
  async () => {
    const address = `test-sol-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const chainSlug = "solana-mainnet";
    const collectionId = await seedCollection(chainSlug, address, 2);
    try {
      let sources = (await hydrationJobSources(chainSlug, address)).map((s) => s.source);
      assert.ok(sources.includes("helius-membership"), "0 of 2 real rows must still enqueue membership");

      await seedTokens(chainSlug, address, 2);
      sources = (await hydrationJobSources(chainSlug, address)).map((s) => s.source);
      assert.ok(!sources.includes("helius-membership"), "2 of 2 real rows must drop membership regardless of any per-source flag");
      assert.ok(sources.includes("magiceden-solana"), "magiceden has no completion gate and must remain unconditional");
    } finally {
      await cleanup(chainSlug, address, collectionId);
    }
  }
);
