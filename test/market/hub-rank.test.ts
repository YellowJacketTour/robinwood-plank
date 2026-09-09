import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { HUB_DEFAULT_ORDER, HUB_SORT_COLUMN } from "../../lib/market/multichain/hub-rank";

/**
 * The rank table, and the contract between its ORDER BY and its index.
 *
 * Measured live 2026-09-09 through the backstage door:
 *
 *     /api/market/multichain?limit=500   4,934 ms, 698 KB
 *     /api/market/multichain?limit=40    HTTP 504 after 60,081 ms
 *
 * Removing `COUNT(*) OVER()` fixed one of TWO full passes. The second was the
 * sort itself: the ordering spanned `plank_multichain_collections` (the
 * filter) and `plank_multichain_snapshots` (almost every sort key), and
 * **Postgres cannot index a sort that spans two tables**. So every page still
 * scanned, hash-joined ~345,000 rows, sorted all of them, and took forty.
 *
 * The failure mode these tests exist to prevent is the nastiest kind: if the
 * ORDER BY and the index drift apart, the results stay CORRECT and only the
 * latency changes. Nothing breaks, nothing logs, and the 60-second timeout
 * quietly comes back.
 */

const MIGRATION = readFileSync(
  "deploy/inmotion/postgres/migrations/107_market_hub_rank.sql",
  "utf8"
).replace(/\r\n/g, "\n");
const STORE = readFileSync("lib/market/multichain/store.ts", "utf8").replace(/\r\n/g, "\n");
const RANK = readFileSync("lib/market/multichain/hub-rank.ts", "utf8").replace(/\r\n/g, "\n");

/** The default index's column list, in declaration order. */
function defaultIndexColumns(): string[] {
  const at = MIGRATION.indexOf("plank_market_hub_rank_default_idx");
  assert.ok(at > 0, "the default index must exist");
  const open = MIGRATION.indexOf("(", MIGRATION.indexOf("ON plank_market_hub_rank", at));
  const close = MIGRATION.indexOf(");", open);
  return MIGRATION.slice(open + 1, close)
    .split(",")
    .map((s) => s.trim().split(/\s+/)[0]!)
    .filter(Boolean);
}

/** The ORDER BY's column list, in the order the query will sort by. */
function defaultOrderColumns(): string[] {
  return HUB_DEFAULT_ORDER.split(",")
    .map((s) => s.trim().replace(/^r\./, "").split(/\s+/)[0]!)
    .filter(Boolean);
}

test("the default ORDER BY matches its index, term for term", () => {
  // THE CONTRACT. A composite index only serves a sort whose leading columns
  // match it in sequence. Reorder one term and the plan falls back to a full
  // sort -- invisibly, because the rows come back correct either way.
  const idx = defaultIndexColumns();
  const ord = defaultOrderColumns();
  // The index leads with chain_slug (the filter); the ORDER BY does not
  // repeat it until the tie-break, which is exactly right for an equality
  // predicate. Compare the sort terms that follow.
  assert.equal(idx[0], "chain_slug", "the index must lead with the filter column");
  const idxSort = idx.slice(1);
  const ordSort = ord.slice(0, idxSort.length);
  assert.deepEqual(
    ordSort,
    idxSort,
    `ORDER BY and index disagree -- the sort will silently stop using the index.\n` +
      `  index: ${idxSort.join(", ")}\n  order: ${ordSort.join(", ")}`
  );
});

test("every sort key lives on the rank table -- none span two tables", () => {
  // The actual bug. A single key still pointing at `s.` or `c.` reintroduces
  // the cross-table sort and the 60-second timeout.
  for (const [name, col] of Object.entries(HUB_SORT_COLUMN)) {
    assert.ok(col.startsWith("r."), `sort "${name}" must order by the rank table, saw "${col}"`);
  }
  for (const term of HUB_DEFAULT_ORDER.split(",")) {
    const t = term.trim();
    if (!t) continue;
    assert.ok(t.startsWith("r."), `default order term must be on the rank table, saw "${t}"`);
  }
});

test("no sort key is an unindexable expression", () => {
  // NULLIF(s.floor_price_wei, '')::numeric was dead code -- the column is
  // NUMERIC(78,0) and can never equal '' -- but it made the sort an
  // expression, which no plain column index can serve.
  for (const [name, col] of Object.entries(HUB_SORT_COLUMN)) {
    assert.ok(!/NULLIF|::|\(/.test(col), `sort "${name}" must be a plain column, saw "${col}"`);
  }
  assert.ok(
    !/NULLIF\(s\.floor_price_wei/.test(STORE.slice(STORE.indexOf("HUB_SORT_COLUMN"))),
    "the dead NULLIF wrapper must not return"
  );
});

test("has_floor is stored, not computed in the sort", () => {
  // `(floor_price_wei IS NOT NULL)` as an expression could never be indexed.
  assert.match(MIGRATION, /has_floor\s+BOOLEAN NOT NULL/, "it must be a real column");
  assert.ok(
    HUB_DEFAULT_ORDER.includes("r.has_floor"),
    "the tie-break must read the stored column"
  );
  assert.ok(
    !/\(s\.floor_price_wei IS NOT NULL\) DESC/.test(HUB_DEFAULT_ORDER),
    "and must not recompute the expression"
  );
});

test("the query filters the rank table, not the catalog", () => {
  // chain_slug leads every index on the rank table. Filtering the catalog
  // instead would force a join before the filter could help.
  const at = STORE.indexOf("FROM plank_market_hub_rank r");
  assert.ok(at > 0, "the hub query must read the rank table");
  assert.match(STORE, /whereClauses\.push\(`r\.chain_slug = ANY/, "the filter must be on r.");
});

test("the rank table is derived and can always be rebuilt", () => {
  // The safety property. If a value ever exists ONLY here, the next rebuild
  // destroys it -- so there must be a rebuild, and it must read the base
  // tables.
  assert.match(RANK, /export async function rebuildHubRank/, "a rebuild path must exist");
  const at = RANK.indexOf("export async function rebuildHubRank");
  const body = RANK.slice(at);
  assert.match(body, /FROM \(\s*\n?\s*SELECT id FROM plank_multichain_collections/,
    "the rebuild must read the base catalog");
  assert.match(body, /LEFT JOIN plank_multichain_snapshots/, "and the base snapshots");
  assert.match(body, /LIMIT \$1::int/, "and must be bounded per call");
});

test("a refresh failure can never fail the write that triggered it", () => {
  // An accelerator must not be able to destroy the real observation it
  // accelerates. Losing measured data to protect a derived index would be
  // exactly backwards.
  const at = RANK.indexOf("export async function refreshHubRank");
  const body = RANK.slice(at, RANK.indexOf("export async function rebuildHubRank"));
  assert.match(body, /try \{/, "the refresh must be guarded");
  assert.match(body, /\} catch \{/, "and must swallow its own failure");
});

test("the snapshot writer keeps the rank row in step", () => {
  // A rank table nobody updates is worse than none: it serves stale ordering
  // forever while looking healthy.
  assert.match(STORE, /await refreshHubRank\(id\);/, "the stats writer must refresh the rank row");
});

test("the migration is idempotent", () => {
  // The runner may re-apply. Every object must tolerate it.
  const creates = MIGRATION.match(/CREATE (TABLE|INDEX)[^;]*/g) ?? [];
  assert.ok(creates.length >= 8, `expected the full index set, saw ${creates.length}`);
  for (const c of creates) {
    assert.match(c, /IF NOT EXISTS/, `not idempotent: ${c.slice(0, 60)}`);
  }
  assert.match(MIGRATION, /ON CONFLICT \(collection_id\) DO UPDATE/, "the seed must be re-runnable");
});

test("the missing chain_slug index on the base catalog is added", () => {
  // The hottest predicate in the app had no index; a comment rationalised it
  // at ~320k rows ("~115ms parallel seq scan"). That reasoning expired.
  assert.match(
    MIGRATION,
    /CREATE INDEX IF NOT EXISTS plank_multichain_collections_chain_idx/,
    "the base table still needs its own chain index for non-hub paths"
  );
});

test("the mostly-null sorts use partial indexes", () => {
  // holder_count is ~80% null and listed_count ~85% (measured over the top 40
  // rows). A full index there is four-fifths dead weight NULLS LAST never
  // reads.
  const holders = MIGRATION.slice(MIGRATION.indexOf("plank_market_hub_rank_holders_idx"));
  assert.match(holders, /WHERE holder_count IS NOT NULL/, "holders index must be partial");
  const listed = MIGRATION.slice(MIGRATION.indexOf("plank_market_hub_rank_listed_idx"));
  assert.match(listed, /WHERE listed_count IS NOT NULL/, "listed index must be partial");
});
