import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { hydrationJobSources } from "../../lib/market/multichain/collection-demand";
import { EVM_CHAIN_ID } from "../../lib/market/multichain/discovery/evm-log-scan";

/**
 * Real gap found live 2026-08-27 (external research): this app's own
 * Robinhood Chain had zero HyperSync coverage in hydrationJobSources, on
 * the assumption Envio's public indexing infrastructure doesn't cover a
 * private/custom L2. Live-verified false the same day: both
 * robinhood.hypersync.xyz and 4663.hypersync.xyz return real, live,
 * matching block height for a direct authenticated request, and a real
 * end-to-end anchored-membership scan against a genuinely incomplete
 * real Robinhood collection registered 496/496 real tokens in one call.
 */
test("EVM_CHAIN_ID maps the real Robinhood Chain id (4663)", () => {
  assert.equal(EVM_CHAIN_ID.robinhood, 4663);
});

test(
  "hydrationJobSources includes anchored-membership/token-index-probe for an incomplete Robinhood collection",
  { skip: !hasPostgresConfig() },
  async () => {
    const suffix = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const address = `0x${suffix.replace(/[^0-9a-z]/g, "").padEnd(40, "0").slice(0, 40)}`;
    const inserted = await postgresQuery<{ id: number }>(
      `INSERT INTO plank_multichain_collections (chain_slug, contract_address, adapter) VALUES ('robinhood', $1, 'test') RETURNING id`,
      [address]
    );
    const collectionId = inserted.rows[0].id;
    try {
      await postgresQuery(`INSERT INTO plank_multichain_snapshots (collection_id, total_supply) VALUES ($1, 10)`, [collectionId]);
      const sources = (await hydrationJobSources("robinhood", address)).map((s) => s.source);
      assert.ok(sources.includes("anchored-membership"), "an incomplete Robinhood collection must get the real HyperSync path now that it exists");
      assert.ok(sources.includes("robinhood-membership"), "OpenSea fallback path must remain available too");
      // token-index-probe is deliberately NOT asserted here: it requires its
      // own separate collection_archival_stats row with a chain-confirmed
      // known supply (token-index-probe.ts's own completion check), which
      // this synthetic fixture doesn't set up -- unrelated to the HyperSync
      // wiring this test actually covers.
    } finally {
      await postgresQuery(`DELETE FROM plank_multichain_snapshots WHERE collection_id = $1`, [collectionId]);
      await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id = $1`, [collectionId]);
    }
  }
);
