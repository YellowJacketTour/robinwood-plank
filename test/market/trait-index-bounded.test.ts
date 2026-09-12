import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";

/**
 * readProjectedTraitIndex runs a `CROSS JOIN LATERAL jsonb_array_elements(traits)`
 * on the request path of /api/market/multichain/trait-index -- a route served
 * `Cache-Control: no-store`, against a table measured at 19.4M rows / 16GB,
 * through a pool capped at PGPOOL_MAX=4. One token with eight traits is eight
 * rows; the collection page calls this on every load.
 *
 * THE FIX IS NOT A ROW CAP.
 *
 * An earlier version capped the result at an invented 200,000 rows. That was
 * the wrong instrument: a row cap is an arbitrary THROUGHPUT ceiling that
 * decides in advance a large collection may not have a complete trait index --
 * and the biggest collections are exactly the ones whose trait filters matter
 * most.
 *
 * The real hazard was never "too many rows", it was "a query that runs forever
 * holds one of four connections". That is already handled by TIME:
 * lib/postgres.ts sets a pool-level statement_timeout (15s web / 80s worker)
 * with a matching client query_timeout, so PostgreSQL cancels a runaway scan
 * before the client abandons it.
 *
 * So: throughput uncapped, the clock is the only bound, and an incomplete read
 * says so. These tests pin that the full result comes back, and that a failed
 * read degrades into the existing work-in-progress path rather than into a
 * confident wrong answer.
 */

const SKIP = { skip: !hasPostgresConfig() };

async function seed(tokenCount: number, traitsPerToken: number) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const chainSlug = "eth-mainnet";
  const collectionSlug = `0x${suffix.replace(/[^0-9a-z]/g, "").padEnd(40, "0").slice(0, 40)}`;
  for (let i = 0; i < tokenCount; i++) {
    const traits = Array.from({ length: traitsPerToken }, (_, t) => ({
      traitType: `Trait${t}`,
      value: `Value${i % 3}`,
    }));
    await postgresQuery(
      `INSERT INTO plank_collection_tokens (chain_slug, collection_slug, token_id, traits, source_observed_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())`,
      [chainSlug, collectionSlug, String(i), JSON.stringify(traits)]
    );
  }
  await postgresQuery(
    `INSERT INTO plank_collection_token_projections (chain_slug, collection_slug, projected_count, partial, provenance, source_observed_at)
     VALUES ($1, $2, $3, false, ARRAY['test'], NOW())`,
    [chainSlug, collectionSlug, tokenCount]
  );
  return { chainSlug, collectionSlug };
}

async function cleanup(chainSlug: string, collectionSlug: string) {
  await postgresQuery(`DELETE FROM plank_collection_tokens WHERE chain_slug = $1 AND collection_slug = $2`, [chainSlug, collectionSlug]);
  await postgresQuery(`DELETE FROM plank_collection_token_projections WHERE chain_slug = $1 AND collection_slug = $2`, [chainSlug, collectionSlug]);
}

test("the source declares no row ceiling", SKIP, async () => {
  // The regression this guards is someone reintroducing a LIMIT "for safety".
  // The safety already exists, as a deadline, one layer down.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../lib/market/multichain/collection-token-store.ts", import.meta.url), "utf8");
  const fn = /export async function readProjectedTraitIndex[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
  assert.ok(fn.length > 0, "the function must be locatable for this assertion to mean anything");
  assert.doesNotMatch(
    fn,
    /\bLIMIT\b/,
    "the trait fan-out must not be capped by row count -- statement_timeout is the bound"
  );
});

test("a complete read returns every trait row, and reports itself complete", SKIP, async () => {
  const { readProjectedTraitIndex } = await import("../../lib/market/multichain/collection-token-store");
  const { chainSlug, collectionSlug } = await seed(40, 5);
  try {
    const result = await readProjectedTraitIndex(chainSlug, collectionSlug);
    assert.ok(result, "a collection with a projection row must return an index");
    assert.equal(result.incomplete, false, "nothing failed, so nothing is missing");
    assert.equal(result.partial, false, "the projection said complete and the read succeeded");
    assert.deepEqual(Object.keys(result.traits).sort(), ["Trait0", "Trait1", "Trait2", "Trait3", "Trait4"]);
    // Every token appears under every trait type: 40 tokens x 5 types.
    const indexedRows = Object.values(result.traits).reduce(
      (n, byValue) => n + Object.values(byValue).reduce((m, ids) => m + ids.length, 0),
      0
    );
    assert.equal(indexedRows, 200, "all 40 x 5 trait rows are present -- nothing was dropped");
  } finally {
    await cleanup(chainSlug, collectionSlug);
  }
});

/**
 * The scale case. A collection large enough that a row cap would have bitten:
 * 2,000 tokens x 30 traits = 60,000 rows, all of which must come back.
 */
test("a large collection gets its COMPLETE index, not a truncated one", SKIP, async () => {
  const { readProjectedTraitIndex } = await import("../../lib/market/multichain/collection-token-store");
  const tokenCount = 2_000;
  const traitsPerToken = 30;
  const { chainSlug, collectionSlug } = await seed(tokenCount, traitsPerToken);
  try {
    const result = await readProjectedTraitIndex(chainSlug, collectionSlug);
    assert.ok(result);
    assert.equal(result.incomplete, false, "this must complete well inside statement_timeout");
    const indexedRows = Object.values(result.traits).reduce(
      (n, byValue) => n + Object.values(byValue).reduce((m, ids) => m + ids.length, 0),
      0
    );
    assert.equal(
      indexedRows,
      tokenCount * traitsPerToken,
      "every trait row must be indexed -- a large collection is exactly the case a row cap would have silently cut"
    );
  } finally {
    await cleanup(chainSlug, collectionSlug);
  }
});

/**
 * THE HONESTY TEST. A read that cannot finish must not look like a collection
 * with no traits.
 *
 * Driven by lowering statement_timeout on this session to something no scan can
 * meet, which is the real mechanism -- not a stubbed throw.
 */
test("a read that cannot finish reports incomplete, and forces partial", SKIP, async () => {
  const { readProjectedTraitIndex } = await import("../../lib/market/multichain/collection-token-store");
  const { chainSlug, collectionSlug } = await seed(600, 20);
  try {
    // 1ms: no real scan completes, so the LATERAL is cancelled by PostgreSQL
    // exactly as it would be under production load.
    await postgresQuery(`SET statement_timeout = 1`);
    const result = await readProjectedTraitIndex(chainSlug, collectionSlug);
    assert.ok(result, "an incomplete read must still return an envelope -- null would read as 'no such collection'");
    assert.equal(result.incomplete, true, "the read failed, and the result must say so");
    assert.equal(
      result.partial,
      true,
      "an incomplete index can never be complete, even though the projection row says partial=false"
    );
    assert.deepEqual(result.traits, {}, "no rows were read, so no traits are claimed");
  } finally {
    await postgresQuery(`SET statement_timeout = DEFAULT`).catch(() => {});
    await cleanup(chainSlug, collectionSlug);
  }
});

test("a collection with no projection row is null, which is a different fact", SKIP, async () => {
  const { readProjectedTraitIndex } = await import("../../lib/market/multichain/collection-token-store");
  const result = await readProjectedTraitIndex("eth-mainnet", "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal(result, null, "'this collection is not projected' must stay distinguishable from 'the read failed'");
});
