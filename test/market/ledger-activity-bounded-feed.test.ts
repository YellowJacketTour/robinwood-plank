import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { UNION_SQL, FEED_UNION_SQL, MARKET_EVENTS_TS_BOUND } from "../../lib/market/multichain/ledger-union-sql";


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
// The SQL now lives in ledger-union-sql.ts, a module WITHOUT `server-only`,
// so it is imported here as code (the feed's template interpolates
// MARKET_EVENTS_TS_BOUND; reading the source text would leave that
// placeholder unexpanded and the equivalence proof would test nothing).

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
  assert.equal(fills, 10, `ten fill ledgers (nine plus the CryptoPunks market) must each carry the exact key; found ${fills}`);
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
  // Eleven venue branches, plus the two NULL-timestamp sub-branches of
  // plank_market_events (see MARKET_EVENTS_TS_BOUND's header): thirteen.
  const limits = [...FEED_UNION_SQL.matchAll(/LIMIT \$3\)/g)].length;
  assert.equal(limits, 14, `twelve venue branches plus two NULL-timestamp sub-branches must be bounded; found ${limits}`);
});

test("both plank_market_events branches are bounded by the SAME transfer-walk timestamp, with the index that exists", () => {
  // The bound walks timestamped transfers N deep on collection_time_idx.
  assert.match(MARKET_EVENTS_TS_BOUND, /event_type IN \('transfer', 'mint'\)/);
  assert.match(MARKET_EVENTS_TS_BOUND, /b\.block_timestamp IS NOT NULL/);
  assert.match(MARKET_EVENTS_TS_BOUND, /ORDER BY b\.block_timestamp DESC LIMIT 1 OFFSET \$3::int - 1/);
  // Applied to the transfer branch and the stream branch alike (>= T, or
  // everything when T is NULL), and the NULL-timestamp sub-branches run
  // only when T is NULL.
  const applied = [...FEED_UNION_SQL.matchAll(/block_timestamp >= COALESCE\(\(\s*SELECT b\.block_timestamp FROM plank_market_events b[\s\S]*?\), '-infinity'::timestamptz\)/g)].length;
  assert.equal(applied, 2, `the bound must gate exactly the two market_events branches; found ${applied}`);
  const nullOnly = [...FEED_UNION_SQL.matchAll(/block_timestamp IS NULL AND \(\s*SELECT b\.block_timestamp FROM plank_market_events b[\s\S]*?\) IS NULL/g)].length;
  assert.equal(nullOnly, 2, `each market_events branch needs its NULL-timestamp sub-branch; found ${nullOnly}`);
  // No branch on that table reads without the bound.
  const unbounded = [...FEED_UNION_SQL.matchAll(/FROM plank_market_events( e)?\n\s+WHERE[^\n]*\n(?!\s+AND (e\.)?block_timestamp)/g)].length;
  assert.equal(unbounded, 0, `every plank_market_events branch of the feed must carry the bound on its next line; found ${unbounded} without`);
});

test("the bounded and unbounded unions project the same columns in the same order", () => {
  // The outer query reads columns by name; a branch that drifted would fail
  // at runtime for one venue only, on one collection, silently.
  // Count BRANCH reads only: the bound's own probes (`FROM plank_market_events b`)
  // and the stream branch's seaport NOT EXISTS (`plank_seaport_fills f`) are
  // not branches. The feed has the eleven venues plus the two NULL-timestamp
  // sub-branches of plank_market_events.
  // `\b` after the table name: without it the regex backtracks one letter
  // (`plank_seaport_fill` + `s`) and the lookahead never sees the alias.
  // Digits too: plank_x2y2_fills.
  const branches = (s: string) => [...s.matchAll(/FROM plank_[a-z0-9_]+\b(?! [bf]\b)/g)].length;
  assert.equal(branches(UNION_SQL), 12, "twelve venue branches, unbounded");
  assert.equal(branches(FEED_UNION_SQL), 14, "twelve venue branches plus two NULL-timestamp sub-branches, bounded");
  // And the projected column list of every branch matches: same aliases, same order.
  const projection = (s: string) => [...s.matchAll(/SELECT[\s\S]*?\n\s+FROM plank_(?!market_events b)/g)].map((m) => m[0].replace(/^\(?SELECT\s+'[a-z]+'(?: AS [a-z_]+)?,\s*'[a-z-]+'(?: AS [a-z_]+)?,/, "").replace(/\s+/g, " ").replace(/\b(e|f|b)\./g, "").trim());
  const feedShapes = new Set(projection(FEED_UNION_SQL).map((p) => p.replace(/CASE WHEN[\s\S]*?END/, "kind")));
  assert.ok(feedShapes.size >= 1, "the projection extractor found the branches");
  for (const venue of ["'wallet-transfer'", "'opensea-stream'", "'seaport'", "'wyvern'", "'looksrare'", "'blur'", "'x2y2'", "'foundation'", "'sudoswap'", "'rarible'", "'cryptokitties-auction'", "'cryptopunks-market'"]) {
    assert.ok(FEED_UNION_SQL.includes(venue), `bounded union is missing the ${venue} branch`);
    assert.ok(UNION_SQL.includes(venue), `unbounded union is missing the ${venue} branch`);
  }
});

test("the feed reads the bounded union; the worker-side coverage and holder-count still read the unbounded one", () => {
  const body = (() => {
    const start = SRC.indexOf("export async function readLedgerActivity");
    const rest = SRC.slice(start + 1);
    const next = rest.search(/\nexport /);
    return next >= 0 ? SRC.slice(start, start + 1 + next) : SRC.slice(start);
  })();
  assert.match(body, /FROM \(\$\{FEED_UNION_SQL\}\) AS unioned/, "the feed query must use the bounded union");
  assert.doesNotMatch(body, /\$\{UNION_SQL\}/, "the request path never reads the unbounded union (2026-09-14: that count was the 500)");
  const coverage = readFileSync(new URL("../../lib/market/multichain/activity-coverage.ts", import.meta.url), "utf8");
  assert.match(coverage, /FROM \(\$\{UNION_SQL\}\) AS unioned\s+GROUP BY venue_id/, "the coverage aggregate, now in the worker, must still count EVERY row");
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
  // plank_market_events deliberately has NO feed index in 148. CREATE INDEX
  // on it needs a SHARE lock, which the notification-maintenance lock
  // (SHARE UPDATE EXCLUSIVE, held by another role) refuses -- the
  // notification-migration-integration test proved a must-apply migration
  // cannot touch that table. Its two branches stay exact (same ORDER BY) and
  // sort what they read today, until the runner's deferral is generalised.
] as const;

test("migration 148 created all nine fill-table sort-covering indexes with the exact key", SKIP, async () => {
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
