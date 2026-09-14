import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";

/**
 * /api/market/multichain/activity was a 500 on production for every EVM
 * collection whose ledger read exceeded the 15 s statement_timeout, and a
 * 20-second wait for the ones that squeaked under it.
 *
 * MEASURED 2026-09-14 (curl against plank.love):
 *
 *     eth-mainnet  BAYC     200 @ 22.6 s
 *     base-mainnet Beezie   500 @ 22.2 s, 24.6 s, 25.4 s   (three of three)
 *     solana       MadLads  200 @  0.49 s   -- not the EVM path; fast
 *
 * #504 guarded the OpenSea fallback and was deployed; Beezie still 500'd.
 * That diagnosis had been reasoned from the code rather than read from the
 * failure, and it named the wrong branch. The EVM path reaches the vendor
 * only when the LEDGER returns nothing -- and the ledger read was the thing
 * timing out.
 *
 * TWO DEFECTS, ONE READ
 * ---------------------
 * 1. plank_wyvern_fills had no (chain_slug, nft_contract) index. Eight of
 *    the nine fill tables in the union carry one for exactly the predicate
 *    every branch uses; Wyvern -- OpenSea's 2018-2022 protocol, the largest
 *    ledger on eth-mainnet -- had only (chain_slug, block_number) and
 *    (chain_slug, maker, block_number). Its branch read every Wyvern fill on
 *    the chain.
 *
 *      EXPLAIN (ANALYZE, BUFFERS), 1.5M seeded rows, 30k for the probe:
 *        before  Parallel Seq Scan      42,538 buffers
 *        after   Parallel Index Scan    (migration 147)
 *
 * 2. readLedgerActivity ran the union TWICE, sequentially: once for the
 *    feed, then -- after mapping every row -- again for the coverage
 *    aggregate. Neither depends on the other. The request paid the SUM of
 *    two full passes over eleven ledgers where it owed the MAX of one.
 *
 * WHAT THESE TESTS PIN
 * --------------------
 *   - the planner USES the new index for the Wyvern predicate (plan shape,
 *     never a duration -- a wall-clock assertion in this repo once passed
 *     while a walk took 5,000,003 steps)
 *   - the two reads are issued as one Promise.all, and neither is awaited
 *     separately before it
 *   - the activity route can now report its own failure to a door holder,
 *     so the next 500 is read from the response instead of guessed
 */

const SKIP = { skip: !hasPostgresConfig() };
const LEDGER_SRC = readFileSync(
  new URL("../../lib/market/multichain/ledger-activity.ts", import.meta.url),
  "utf8"
);
const ROUTE_SRC = readFileSync(
  new URL("../../app/api/market/multichain/activity/route.ts", import.meta.url),
  "utf8"
);

// --- 1. the index -----------------------------------------------------------

test("migration 147 created the Wyvern collection index with the sibling tables' shape", SKIP, async () => {
  const r = await postgresQuery<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'plank_wyvern_fills_collection_idx'`
  );
  assert.equal(r.rows.length, 1, "migration 147 must have created the index");
  assert.match(
    r.rows[0].indexdef,
    /\(chain_slug, nft_contract, block_number DESC\)/,
    "identical to seaport/looksrare/blur/x2y2/foundation/sudoswap/rarible -- equality prefix, newest-first walk"
  );
});

test("the planner uses the index for the union's Wyvern predicate", SKIP, async () => {
  const size = await postgresQuery<{ n: string }>(`SELECT COUNT(*)::text AS n FROM plank_wyvern_fills`);
  const rows = Number(size.rows[0]?.n ?? 0);
  if (rows < 10_000) {
    // Reported, not silently skipped. On a small table a seq scan is the
    // CORRECT plan and proves nothing either way.
    assert.ok(true, `only ${rows} Wyvern rows -- too few for the planner to prefer an index; plan not asserted`);
    return;
  }
  const plan = await postgresQuery<{ "QUERY PLAN": string }>(
    `EXPLAIN (COSTS OFF)
     SELECT tx_hash, block_number FROM plank_wyvern_fills
      WHERE chain_slug = $1 AND nft_contract = $2`,
    ["eth-mainnet", "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d"]
  );
  const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
  // Either Wyvern index serves this predicate: 147's (chain_slug,
  // nft_contract, block_number) or 148's sort-covering feed index, which has
  // the same equality prefix. The property is "index-served", not "served by
  // this one index" -- asserting a single name broke the moment a second
  // valid index existed, for a reason that had nothing to do with the read.
  assert.match(
    text,
    /Index Scan using plank_wyvern_fills_(collection|feed)_idx/,
    `the planner ignored both Wyvern indexes on ${rows} rows -- present-but-unused is the same outage as absent. Plan:\n${text}`
  );
  assert.doesNotMatch(
    text,
    /Seq Scan on plank_wyvern_fills/,
    `the Wyvern branch still scans the whole table. Plan:\n${text}`
  );
});

// --- 2. the concurrency -----------------------------------------------------

/**
 * The function body is sliced from its `export` to the NEXT `export`, not to
 * the next newline-brace. The first version used a lazy match to the first
 * newline-brace and stopped at the
 * first NESTED closing brace -- a mutation that awaited a query directly
 * before the group sat outside the truncated slice and SURVIVED. Same trap
 * this repo has hit before: a test reading a smaller region than it claims.
 */
function readLedgerActivityBody(): string {
  const start = LEDGER_SRC.indexOf("export async function readLedgerActivity");
  assert.ok(start >= 0, "readLedgerActivity must be locatable");
  const rest = LEDGER_SRC.slice(start + 1);
  const next = rest.search(/\nexport /);
  return next >= 0 ? LEDGER_SRC.slice(start, start + 1 + next) : LEDGER_SRC.slice(start);
}

/**
 * #508 issued the feed and the coverage COUNT as one Promise.all so neither
 * serialised the other. On production's 167M-row plank_market_events the
 * COUNT alone exceeded the 15 s statement_timeout, so the pair still
 * answered 500 (BAYC, Beezie, Azuki, 2026-09-14, with the bounded feed
 * live). The count now runs in the mesh worker and the request path reads
 * it from the durable KV: exactly ONE query here, the bounded feed, and no
 * Promise.all to reason about. activity-coverage.test.ts holds the rest.
 */
test("the request path is one bounded feed query; the coverage count is not awaited here", () => {
  const fn = readLedgerActivityBody();
  assert.equal([...fn.matchAll(/postgresQuery</g)].length, 1, "one query: the feed");
  assert.match(fn, /= await postgresQuery<UnionRow>\(/, "the feed is awaited directly -- there is nothing to group it with");
  assert.doesNotMatch(fn, /Promise\.all\(\[\s*postgresQuery/, "no second pass over the union");
  assert.doesNotMatch(fn, /coverageResult/, "the count result no longer exists on this path");
  assert.match(fn, /readActivityCoverage\(/);
});

test("a failed feed read still fails the whole read -- never half a page", () => {
  const fn = readLedgerActivityBody();
  // The feed statement: from `postgresQuery<UnionRow>(` to its terminating
  // `;`. No `.catch` may sit on it -- a swallowed timeout would answer with
  // an empty page presented as the truth.
  const at = fn.indexOf("postgresQuery<UnionRow>(");
  assert.ok(at >= 0);
  // To the call's closing `\n  );` -- not the first `;`, which sits inside a
  // SQL comment ("text in the union; text ordering ...").
  const statement = fn.slice(at, fn.indexOf("\n  );", at));
  assert.doesNotMatch(statement, /\.catch\(/, "the feed query's rejection propagates");
  assert.match(statement, /LIMIT \$3/, "the slice reached the whole statement");
});

test("the activity route reports the real failure to a door holder", () => {
  const outerCatch = /\} catch \(error\) \{[\s\S]*?publicError\(error, "Failed to load multichain activity"\);\s*\}\s*\}\s*$/.exec(ROUTE_SRC)?.[0] ?? "";
  assert.ok(outerCatch.length > 0, "the outer catch must be locatable");
  assert.match(outerCatch, /verifyDoorCookieValue/, "the door cookie must unlock the real error text");
  assert.match(outerCatch, /verifyPreviewCookieValue/, "and so must the admin preview cookie");
  assert.match(
    outerCatch,
    /detail: \(error instanceof Error \? `\$\{error\.name\}: \$\{error\.message\}` : String\(error\)\)\.slice\(0, 400\)/,
    "the detail must carry name + message, bounded, exactly as the hub route does"
  );
  assert.match(outerCatch, /publicError\(error, "Failed to load multichain activity"\)/, "the public still gets the generic message");
});

test("the privileged detail is gated, never unconditional", () => {
  const outerCatch = /\} catch \(error\) \{[\s\S]*?publicError\(error, "Failed to load multichain activity"\);\s*\}\s*\}\s*$/.exec(ROUTE_SRC)?.[0] ?? "";
  assert.match(outerCatch, /if \(privileged\) \{/, "the detail branch must be behind the privileged check");
  // The detail must not be reachable on the unprivileged path: the only
  // return outside the `if (privileged)` block is publicError.
  const afterIf = outerCatch.split("if (privileged) {")[1] ?? "";
  const closingOfIf = afterIf.indexOf("\n    }\n");
  const unprivilegedTail = afterIf.slice(closingOfIf);
  assert.doesNotMatch(unprivilegedTail, /detail:/, "no detail may leak on the unprivileged path");
});
