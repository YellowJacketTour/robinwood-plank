import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { metadataCountersToShape, RARITY_PROVISIONAL_THRESHOLD } from "../../lib/market/multichain/archival-ledger";
import { provisionalTraitsLabel, PROVISIONAL_TRAITS_THRESHOLD } from "../../components/market/hydration/MetadataCoverageBar";
import { rarityDemandJob, rarityDemandSource, RARITY_DEMAND_PRIORITY } from "../../lib/market/multichain/rarity-index-runner";

/**
 * AUDIT lens 4 #5 (Batch F5) honest coverage counters + provisional label,
 * and #8 (Batch F8) rarity GET enqueues a demand job instead of walking
 * OpenSea in the web process.
 */

test("metadataCountersToShape: three ratios over one denominator; provisional below 99.5% traits", () => {
  assert.equal(RARITY_PROVISIONAL_THRESHOLD, 0.995);
  const { shape, provisional } = metadataCountersToShape({ expected: 10_000, terminal: 10_000, withTraits: 312, withImage: 9_800 });
  assert.equal(shape.terminalCoverage, 1);
  assert.equal(shape.traitsCoverage, 0.0312);
  assert.equal(shape.imageCoverage, 0.98);
  assert.equal(provisional, true, "BAYC-shaped: fetched 100%, traits 3.12% -> provisional");

  const done = metadataCountersToShape({ expected: 10_000, terminal: 9_990, withTraits: 9_960, withImage: 9_960 });
  assert.equal(done.provisional, false, "99.6% traits clears the line");

  const empty = metadataCountersToShape({ expected: 0, terminal: 0, withTraits: 0, withImage: 0 });
  assert.equal(empty.shape.traitsCoverage, null);
  assert.equal(empty.provisional, true, "nothing expected -> nothing proven");

  const over = metadataCountersToShape({ expected: 100, terminal: 150, withTraits: 150, withImage: 150 });
  assert.equal(over.shape.traitsCoverage, 1, "ratios are clamped to 1, never > 100%");
});

test("provisionalTraitsLabel: 'Provisional (N% traits)' below the line, null at/above it, never rounds up to 100", () => {
  assert.equal(PROVISIONAL_TRAITS_THRESHOLD, 0.995);
  assert.equal(provisionalTraitsLabel(0.0312), "Provisional (3.12% traits)");
  assert.equal(provisionalTraitsLabel(0.5), "Provisional (50.0% traits)");
  assert.equal(provisionalTraitsLabel(0.9949), "Provisional (99.4% traits)");
  assert.equal(provisionalTraitsLabel(0.995), null);
  assert.equal(provisionalTraitsLabel(1), null);
  assert.equal(provisionalTraitsLabel(null), null);
  assert.equal(provisionalTraitsLabel(undefined), null);
  assert.equal(provisionalTraitsLabel(Number.NaN), null);
});

test("rarityDemandJob: mesh-lane demand job, source opensea-membership, priority 100, address-normalized subject", () => {
  assert.equal(RARITY_DEMAND_PRIORITY, 100);
  const job = rarityDemandJob("eth-mainnet", "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D");
  assert.ok(job);
  assert.equal(job!.kind, "mesh-lane:eth-mainnet");
  assert.equal(job!.source, "opensea-membership");
  assert.equal(job!.priority, 100);
  assert.equal(job!.subject, "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d");
  assert.equal(job!.jobKey, "demand:opensea-membership:eth-mainnet:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d");
  assert.equal(job!.chainSlug, "eth-mainnet");
});

test("rarityDemandSource: subject-blind chains get no job rather than a job that fails visibly", () => {
  assert.equal(rarityDemandSource("solana-mainnet"), null);
  assert.equal(rarityDemandSource("bitcoin-mainnet"), null);
  assert.equal(rarityDemandSource("eth-mainnet"), "opensea-membership");
  assert.equal(rarityDemandSource("robinhood"), "opensea-membership");
  assert.equal(rarityDemandJob("solana-mainnet", "claynosaurz"), null);
});

test(
  "getArchivalStatsForCollection reports metadataCounters (terminal/withTraits/withImage over expected) and metadataProvisional",
  { skip: !hasPostgresConfig() },
  async () => {
    const { getArchivalStatsForCollection } = await import("../../lib/market/multichain/archival-ledger");
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2)}`.replace(/[^0-9a-z]/g, "");
    const chainSlug = "eth-mainnet";
    const address = `0x${suffix.padEnd(40, "0").slice(0, 40)}`;
    const collectionId = (
      await postgresQuery<{ id: number }>(
        `INSERT INTO plank_multichain_collections (chain_slug, contract_address, adapter) VALUES ($1, $2, 'test') RETURNING id`,
        [chainSlug, address]
      )
    ).rows[0].id;
    try {
      // 4 rows expected; 3 terminal (2 complete + 1 empty), 1 with traits, 2 with image.
      const rows: Array<[string, string, string | null, string]> = [
        ["0", "complete", "ipfs://img/0", '[{"traitType":"Hat","value":"Cap"}]'],
        ["1", "complete", "ipfs://img/1", "[]"],
        ["2", "empty", null, "[]"],
        ["3", "pending", null, "[]"],
      ];
      for (const [id, state, image, traits] of rows) {
        await postgresQuery(
          `INSERT INTO plank_collection_tokens (chain_slug, collection_slug, token_id, name, image_url, traits, metadata_state, source_observed_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())`,
          [chainSlug, address, id, `Token #${id}`, image, traits, state]
        );
      }
      await postgresQuery(
        `INSERT INTO plank_collection_token_projections (chain_slug, collection_slug, projected_count, expected_count, partial, provenance, source_observed_at)
         VALUES ($1, $2, 4, 4, false, ARRAY['test'], NOW())`,
        [chainSlug, address]
      );
      const now = new Date();
      await postgresQuery(
        `INSERT INTO collection_archival_stats (chain_slug, collection_key, known_supply, tokens_ever_hydrated, archival_score, score_method, fills_ever_stored, first_archived_at, last_archived_at, organic_hits)
         VALUES ($1, $2, 4, 4, 1, 'supply_ratio', 0, $3, $3, 0)`,
        [chainSlug, address, now]
      );

      const stats = await getArchivalStatsForCollection(chainSlug, address);
      assert.ok(stats);
      assert.ok(stats!.metadataCounters, "counters present on the single-collection read");
      assert.equal(stats!.metadataCounters!.expected, 4);
      assert.equal(stats!.metadataCounters!.terminal, 3);
      assert.equal(stats!.metadataCounters!.withTraits, 1);
      assert.equal(stats!.metadataCounters!.withImage, 2);
      assert.equal(stats!.traitsCoverage, 0.25);
      assert.equal(stats!.metadataProvisional, true);
      // The legacy name-or-image number still reads 4/4 = 100% here -- the
      // exact lie the counters exist to expose.
      assert.equal(stats!.metadataTokens, 4);
      assert.equal(stats!.metadataCoverage, 1);
    } finally {
      await postgresQuery(`DELETE FROM plank_collection_tokens WHERE chain_slug = $1 AND collection_slug = $2`, [chainSlug, address]);
      await postgresQuery(`DELETE FROM plank_collection_token_projections WHERE chain_slug = $1 AND collection_slug = $2`, [chainSlug, address]);
      await postgresQuery(`DELETE FROM collection_archival_stats WHERE chain_slug = $1 AND collection_key = $2`, [chainSlug, address]);
      await postgresQuery(`DELETE FROM plank_multichain_snapshots WHERE collection_id = $1`, [collectionId]).catch(() => {});
      await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id = $1`, [collectionId]);
    }
  }
);
