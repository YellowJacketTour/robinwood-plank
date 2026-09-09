import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { COLLECTION_MATCH_SQL } from "../../lib/market/multichain/collection-key-sql";

/**
 * The order-book token lookup must be a point lookup, not a collection scan.
 *
 * WHAT WENT WRONG. `readProjectedTokensByIds` filters on
 * `chain_slug = $1 AND lower(collection_slug) = lower($2) AND token_id = ANY($3)`.
 * The primary key is (chain_slug, collection_slug, token_id) -- case
 * SENSITIVE -- so `lower()` makes it unusable, and the only matching index
 * put token_id FOURTH, behind a computed `token_id::numeric` expression the
 * ANY() filter does not constrain. Postgres seeks two columns and scans the
 * rest of the collection: ~10,000 wide rows for Milady to return 30.
 *
 * A query that says "one indexed query" in a PR description and performs a
 * per-collection scan is the same species as coverage advancing over a filter
 * that matched nothing -- it reports the shape it does not have.
 *
 * These are source assertions: proving the PLAN needs a live database with
 * production-sized data, which CI does not have. What CI can hold is the
 * invariant that the index's leading columns still match the predicate.
 */

const MIGRATIONS = path.join(process.cwd(), "deploy/inmotion/postgres/migrations");
const ALL_SQL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8"))
  .join("\n");

const STORE = readFileSync(
  path.join(process.cwd(), "lib/market/multichain/collection-token-store.ts"),
  "utf8",
);

test("an index exists whose leading columns are exactly the lookup predicate", () => {
  // (chain_slug, lower(collection_slug), token_id) -- token_id THIRD, with
  // nothing between it and the two equality columns.
  const re =
    /ON plank_collection_tokens\s*\(\s*chain_slug\s*,\s*lower\(collection_slug\)\s*,\s*token_id\s*\)/i;
  assert.ok(
    re.test(ALL_SQL),
    "no index supports `chain_slug = ? AND lower(collection_slug) = ? AND token_id = ANY(?)` " +
      "as a point lookup -- the query would scan the whole collection",
  );
});

test("the lookup query still has the shape that index serves", () => {
  const at = STORE.indexOf("export async function readProjectedTokensByIds");
  assert.ok(at > 0, "found the lookup");
  const fn = STORE.slice(at, at + 900);

  assert.ok(fn.includes("${COLLECTION_MATCH_SQL}"), "lookup uses the shared chain-aware predicate");
  assert.ok(/lower\(collection_slug\) = lower\(\$2\)/.test(COLLECTION_MATCH_SQL), "EVM branch retains its expression-index predicate");
  assert.ok(/AND collection_slug = \$2/.test(COLLECTION_MATCH_SQL), "non-EVM branch uses exact identity and the primary key");
  assert.ok(/token_id = ANY\(\$3::text\[\]\)/.test(fn), "token ids are matched as a set");
  // If someone adds ORDER BY / OFFSET here, this stops being a point lookup
  // and quietly inherits the browse path's cost.
  assert.ok(!/ORDER BY/i.test(fn), "a point lookup must not sort: sorting is the browse path's job");
  assert.ok(!/OFFSET/i.test(fn), "a point lookup must not paginate");
});

test("the browse index is NOT what serves the point lookup", () => {
  // Pins the reason the new index was needed: token_id sits behind a computed
  // expression there, so an equality filter on it cannot be an index seek.
  const browse =
    /ON plank_collection_tokens\s*\(chain_slug,\s*lower\(collection_slug\),\s*\n?\s*\(CASE WHEN token_id/i;
  assert.ok(
    browse.test(ALL_SQL),
    "the browse index still leads with a computed column -- if that changed, " +
      "re-check whether the point index is still necessary",
  );
});

test("the new migration is additive only", () => {
  const file = readFileSync(
    path.join(MIGRATIONS, "105_token_point_lookup_index.sql"),
    "utf8",
  );
  assert.ok(/CREATE INDEX IF NOT EXISTS/i.test(file), "idempotent create");
  assert.ok(!/DROP\s|ALTER TABLE|TRUNCATE|DELETE FROM/i.test(file), "nothing destructive");
});
