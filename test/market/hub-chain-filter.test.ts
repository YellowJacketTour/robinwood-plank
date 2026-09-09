import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery, closePostgres } from "../../lib/postgres";
import { listCollectionsWithSnapshotsPage } from "../../lib/market/multichain/store";
import { CHAIN_MANIFESTS } from "../../lib/market/multichain/chains/manifest";

test("every supported chain filter executes the page and count queries", { skip: !hasPostgresConfig() }, async () => {
  try {
    for (const chain of CHAIN_MANIFESTS) {
      const result = await listCollectionsWithSnapshotsPage({ chainSlugs: [chain.chainSlug], limit: 1 });
      const expected = await postgresQuery<{n: string}>("SELECT count(*)::text AS n FROM plank_multichain_collections WHERE chain_slug = $1", [chain.chainSlug]);
      assert.equal(result.totalCount, Number(expected.rows[0].n), chain.chainSlug);
      assert.ok(result.collections.every(row => row.chainSlug === chain.chainSlug));
    }
  } finally { await closePostgres(); }
});
