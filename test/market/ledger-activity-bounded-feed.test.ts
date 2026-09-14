import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";

/**
 * ledger-activity.ts transitively imports `server-only`, which throws the
 * moment it is loaded outside a React Server Component -- so the module
 * cannot be imported here (see test:market-server in package.json for the
 * one place that condition is set). Both SQL constants are plain template
 * literals with no interpolation, so they are read straight out of the
 * source text, exactly as ledger-activity-read-path.test.ts reads the file.
 * A constant that stopped being a plain literal would fail the extraction
 * loudly rather than silently testing an empty string.
 */
function sqlConstant(src: string, name: string): string {
  const open = src.indexOf(`export const ${name} = \``);
  assert.ok(open >= 0, `${name} must be an exported template literal`);
  const start = open + `export const ${name} = \``.length;
  const close = src.indexOf("\n`;", start);
  assert.ok(close > start, `${name} must close with a line that is exactly \`;`);
  const body = src.slice(start, close);
  assert.doesNotMatch(body, /\$\{/, `${name} must have no interpolation, or this extraction is not the real SQL`);
  assert.ok(body.length > 1_000, `${name} looks truncated (${body.length} chars)`);
  return body;
}

/**
 * The activity feed read every row a collection had ever had, across eleven
 * ledgers, before sorting to `limit`. Migration 147 made that possible where
 * it had been impossible; it did not make it instant.
 *
 * MEASURED (EXPLAIN ANALYZE, BUFFERS; seeded, all eleven branches, BAYC):
 *
 *     LIMIT after the union (before)     53,913 buffers   top-N heapsort over ~90k rows
 *     LIMIT inside each branch (after)      102 buffers   0.4 ms, every branch an Index Scan
 *
 * THE PROPERTY EVERYTHING RESTS ON
 * --------------------------------
 * If every branch's ORDER BY is the SAME total order as the outer sort, the
 * union of per-branch top-Ns is a superset of the true top-N, and the outer
 * sort over (11 x N) rows is exact. That is structural -- it assumes nothing
 * about the data -- and it is the only reason a bounded read can be trusted
 * to return what the unbounded one did.
 *
 * Two earlier designs assumed more and were WRONG, caught by the set
 * comparison below before any code was written:
 *   - per-branch ORDER BY block_number DESC: correct only when timestamp is
 *     monotone in block, which un-backfilled timestamps violate. BAYC: 50 of
 *     50 rows differed on a cyclic seed.
 *   - the same with NULLS FIRST for stream rows: the transfer branch also
 *     holds stream-venue rows with NULL block_number. Beezie: 44 of 50.
 *
 * So the centrepiece here is that comparison, made permanent: bounded and
 * unbounded top-N must be IDENTICAL SETS on the seeded data. A mutation that
 * changes any branch's sort key fails it.
 */

const SKIP = { skip: !hasPostgresConfig() };
const SRC = readFileSync(new URL("../../lib/market/multichain/ledger-activity.ts", import.meta.url), "utf8");
const UNION_SQL = sqlConstant(SRC, "UNION_SQL");
const FEED_UNION_SQL = sqlConstant(SRC, "FEED_UNION_SQL");

const GLOBAL_ORDER =
  "ORDER BY COALESCE(block_timestamp, to_timestamp(0)) DESC, block_number::numeric DESC NULLS LAST, log_index DESC";

const PROBES = [
  { chain: "eth-mainnet", key: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d", name: "BAYC" },
  { chain: "base-mainnet", key: "0xbb5ec6fd4b61723bd45c399840f1d868840ca16f", name: "Beezie" },
];

async function seededRows(chain: string, key: string): Promise<number> {
  const r = await postgresQuery<{ n: string }>(
    `SELECT (
       (SELECT COUNT(*) FROM plank_market_events WHERE chain_slug = $1 AND lower(collection_key) = $2) +
       (SELECT COUNT(*) FROM plank_seaport_fills WHERE chain_slug = $1 AND nft_contract = $2) +
       (SELECT COUNT(*) FROM plank_wyvern_fills WHERE chain_slug = $1 AND nft_contract = $2)
     )::text AS n`,
    [chain, key]
  );
  return Number(r.rows[0]?.n ?? 0);
}

// --- the equivalence proof, permanent ---------------------------------------

for (const p of PROBES) {
  test(`bounded and unbounded top-50 are IDENTICAL SETS: ${p.name}`, SKIP, async () => {
    const rows = await seededRows(p.chain, p.key);
    if (rows < 1_000) {
      // Reported, not silently skipped: on a tiny collection both shapes
      // return everything and the comparison proves nothing.
      assert.ok(true, `only ${rows} rows seeded for ${p.name} -- equivalence not exercised`);
      return;
    }
    const r = await postgresQuery<{ old_n: string; new_n: string; only_old: string; only_new: string }>(
      `WITH old_top AS (
         SELECT venue_id, tx_hash, log_index FROM (${UNION_SQL}) AS u ${GLOBAL_ORDER} LIMIT $3
       ), new_top AS (
         SELECT venue_id, tx_hash, log_index FROM (${FEED_UNION_SQL}) AS u ${GLOBAL_ORDER} LIMIT $3
       )
       SELECT (SELECT COUNT(*) FROM old_top)::text AS old_n,
              (SELECT COUNT(*) FROM new_top)::text AS new_n,
              (SELECT COUNT(*) FROM (SELECT * FROM old_top EXCEPT SELECT * FROM new_top) x)::text AS only_old,
              (SELECT COUNT(*) FROM (SELECT * FROM new_top EXCEPT SELECT * FROM old_top) y)::text AS only_new`,
      [p.chain, p.key, 50]
    );
    const row = r.rows[0];
    assert.equal(row.old_n, "50", "the unbounded read must fill the page for this to mean anything");
    assert.equal(row.new_n, "50", "the bounded read must fill the page too");
    assert.equal(
      row.only_old,
      "0",
      `${row.only_old} rows are in the unbounded top-50 but NOT the bounded one -- the bounded read is dropping real events`
    );
    assert.equal(
      row.only_new,
      "0",
      `${row.only_new} rows are in the bounded top-50 but NOT the unbounded one -- a branch's sort key disagrees with the global key`
    );
  });
}

// --- the shape that makes the proof hold ------------------------------------

test("every bounded branch orders by the exact global key, then LIMIT $3", () => {
  // Fill tables: block_number is NOT NULL, so no NULLS LAST on it.
  const fillOrder = /ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC\s+LIMIT \$3\)/g;
  const fills = [...FEED_UNION_SQL.matchAll(fillOrder)].length;
  assert.equal(fills, 9, `nine fill ledgers must each carry the exact key; found ${fills}`);
  // market_events transfer branch: block_number IS nullable, tie-break is event_index.
  assert.match(
    FEED_UNION_SQL,
    /ORDER BY block_timestamp DESC NULLS LAST, block_number DESC NULLS LAST, event_index DESC\s+LIMIT \$3\)/,
    "the transfer branch must order NULL block numbers last, matching the global key"
  );
  // stream branch: no block_number, tie-break is sub_index.
  assert.match(
    FEED_UNION_SQL,
    /ORDER BY e\.block_timestamp DESC NULLS LAST, e\.sub_index DESC\s+LIMIT \$3\)/,
    "the stream branch must order by its own tie-break"
  );
  const limits = [...FEED_UNION_SQL.matchAll(/LIMIT \$3\)/g)].length;
  assert.equal(limits, 11, `all eleven branches must be bounded; found ${limits}`);
});

test("the bounded and unbounded unions project the same columns in the same order", () => {
  // The outer query reads columns by name; a branch that drifted would fail
  // at runtime for one venue only, on one collection, silently.
  const cols = (s: string) => [...s.matchAll(/FROM plank_[a-z_]+/g)].length;
  assert.equal(cols(FEED_UNION_SQL), cols(UNION_SQL), "same eleven FROM clauses");
  for (const venue of ["'wallet-transfer'", "'opensea-stream'", "'seaport'", "'wyvern'", "'looksrare'", "'blur'", "'x2y2'", "'foundation'", "'sudoswap'", "'rarible'", "'cryptokitties-auction'"]) {
    assert.ok(FEED_UNION_SQL.includes(venue), `bounded union is missing the ${venue} branch`);
    assert.ok(UNION_SQL.includes(venue), `unbounded union is missing the ${venue} branch`);
  }
});

test("the feed reads the bounded union; coverage and holder-count still read the unbounded one", () => {
  const body = (() => {
    const start = SRC.indexOf("export async function readLedgerActivity");
    const rest = SRC.slice(start + 1);
    const next = rest.search(/\nexport /);
    return next >= 0 ? SRC.slice(start, start + 1 + next) : SRC.slice(start);
  })();
  assert.match(body, /FROM \(\$\{FEED_UNION_SQL\}\) AS unioned/, "the feed query must use the bounded union");
  assert.match(body, /FROM \(\$\{UNION_SQL\}\) AS unioned\s+GROUP BY venue_id/, "the coverage aggregate must still count EVERY row");
  const holder = SRC.slice(SRC.indexOf("export async function deriveApproxHolderCountFromLedger"));
  assert.match(holder, /WITH events AS \(\$\{UNION_SQL\}\)/, "holder-count needs every row, not a page of them");
  assert.doesNotMatch(holder.slice(0, holder.indexOf("\nexport ") > 0 ? holder.indexOf("\nexport ") : undefined), /FEED_UNION_SQL/, "holder-count must never be bounded");
});

// --- the indexes ------------------------------------------------------------

const FEED_INDEXES = [
  ["plank_seaport_fills_feed_idx", "(chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC)"],
  ["plank_wyvern_fills_feed_idx", "(chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC)"],
  ["plank_looksrare_fills_feed_idx", "(chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC)"],
  ["plank_blur_fills_feed_idx", "(chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC)"],
  ["plank_x2y2_fills_feed_idx", "(chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC)"],
  ["plank_foundation_fills_feed_idx", "(chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC)"],
  ["plank_sudoswap_fills_feed_idx", "(chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC)"],
  ["plank_rarible_fills_feed_idx", "(chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC)"],
  ["plank_cryptokitties_fills_feed_idx", "(chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC)"],
  ["plank_market_events_feed_idx", "(chain_slug, lower(collection_key), block_timestamp DESC NULLS LAST, block_number DESC NULLS LAST, event_index DESC)"],
  ["plank_market_events_stream_feed_idx", "(chain_slug, lower(collection_key), block_timestamp DESC NULLS LAST, sub_index DESC) WHERE (venue_id = 'opensea-stream'::text)"],
] as const;

test("migration 148 created all eleven sort-covering indexes with the exact key", SKIP, async () => {
  const r = await postgresQuery<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE indexname LIKE '%\\_feed\\_idx'`
  );
  const byName = new Map(r.rows.map((x) => [x.indexname, x.indexdef]));
  for (const [name, shape] of FEED_INDEXES) {
    const def = byName.get(name);
    assert.ok(def, `${name} is missing -- its branch will read every row and sort`);
    assert.ok(
      def.includes(shape),
      `${name} does not carry the exact per-branch sort key.\n  want: ${shape}\n  have: ${def}`
    );
  }
});

test("the planner walks a feed index for a bounded branch and never sorts the whole ledger", SKIP, async () => {
  const rows = await seededRows("eth-mainnet", "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d");
  if (rows < 10_000) {
    assert.ok(true, `only ${rows} rows seeded -- plan shape not asserted`);
    return;
  }
  const plan = await postgresQuery<{ "QUERY PLAN": string }>(
    `EXPLAIN (COSTS OFF)
     SELECT tx_hash FROM plank_wyvern_fills
      WHERE chain_slug = $1 AND nft_contract = $2
      ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC
      LIMIT 50`,
    ["eth-mainnet", "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d"]
  );
  const text = plan.rows.map((x) => x["QUERY PLAN"]).join("\n");
  assert.match(text, /plank_wyvern_fills_feed_idx/, `the bounded branch must walk its feed index. Plan:\n${text}`);
  assert.doesNotMatch(text, /Sort/, `a Sort node means the index does not cover the key and every row is read. Plan:\n${text}`);
});
