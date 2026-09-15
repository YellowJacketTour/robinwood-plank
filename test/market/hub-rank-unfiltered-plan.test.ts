import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { hasPostgresConfig, postgresQuery, closePostgres } from "../../lib/postgres";
import { HUB_DEFAULT_ORDER, HUB_SORT_COLUMN } from "../../lib/market/multichain/hub-rank";

/**
 * The hub's UNFILTERED rankings are the page every visitor lands on.
 *
 * test/market/hub-rank.test.ts already asserts that HUB_DEFAULT_ORDER matches
 * plank_market_hub_rank_default_idx "term for term" -- and it passed for the
 * whole time the unfiltered view was reading all 300,351 rows and sorting
 * them, because that index leads with chain_slug and the default view has no
 * chain equality to satisfy it. Matching column NAMES is not the property
 * that matters. These tests ask the PLANNER what it actually does.
 */
const SKIP = { skip: !hasPostgresConfig() };
const MIGRATION = readFileSync("deploy/inmotion/postgres/migrations/151_hub_rank_global_sort_indexes.sql", "utf8");

/** The tie-break listCollectionsWithSnapshotsPage appends to every sorted order. */
const TIE_BREAK = "r.has_floor DESC, r.holder_count DESC NULLS LAST, r.volume_30d_wei DESC NULLS LAST, r.chain_slug, r.contract_address";

async function planFor(orderBy: string, where = ""): Promise<string> {
  const rows = await postgresQuery<{ "QUERY PLAN": string }>(
    `EXPLAIN (COSTS OFF) SELECT r.contract_address FROM plank_market_hub_rank r ${where} ORDER BY ${orderBy} LIMIT 50`
  );
  return rows.rows.map((r) => r["QUERY PLAN"]).join("\n");
}

async function rowCount(): Promise<number> {
  const r = await postgresQuery<{ n: string }>(`SELECT COUNT(*)::text AS n FROM plank_market_hub_rank`);
  return Number(r.rows[0]?.n ?? 0);
}

test("the UNFILTERED default order is served by an index -- no scan, no sort", SKIP, async () => {
  if ((await rowCount()) < 1_000) {
    assert.ok(true, "too few rows seeded for the planner to be forced -- plan shape not asserted");
    return;
  }
  const plan = await planFor(HUB_DEFAULT_ORDER.trim());
  // "Index Only Scan" when the index covers every selected column, plain
  // "Index Scan" otherwise -- either way the index is doing the ordering.
  assert.match(plan, /Index (Only )?Scan using plank_market_hub_rank_global_idx/, `the landing page's order must walk its index. Plan:\n${plan}`);
  assert.doesNotMatch(plan, /Seq Scan/, `a Seq Scan here reads every collection. Plan:\n${plan}`);
  assert.doesNotMatch(plan, /\bSort\b/, `a Sort here means the index does not cover the order. Plan:\n${plan}`);
});

test("every user-selectable sort is served UNFILTERED too", SKIP, async () => {
  if ((await rowCount()) < 1_000) {
    assert.ok(true, "too few rows seeded -- plan shape not asserted");
    return;
  }
  // Exactly the ORDER BY listCollectionsWithSnapshotsPage builds for a sort.
  for (const [name, column] of Object.entries(HUB_SORT_COLUMN)) {
    const orderBy = `${column} DESC NULLS LAST, r.is_vault_backed DESC, r.sales_24h DESC NULLS LAST, ${TIE_BREAK}`;
    const plan = await planFor(orderBy);
    if (name === "name") continue; // contract_address: the tie-break itself, no separate index
    if (name === "holders" || name === "listed") {
      // 151 indexes these PARTIALly (WHERE NOT NULL), exactly as 107 does --
      // they are ~80-85% NULL in production. A partial index the local seed
      // has one row for is one the planner rightly ignores, so the plan
      // shape here would measure the seed, not the schema. The partial
      // definitions are asserted as text below instead.
      continue;
    }
    assert.doesNotMatch(plan, /Seq Scan/, `sort "${name}" reads every row unfiltered. Plan:\n${plan}`);
    assert.doesNotMatch(plan, /\bSort\b/, `sort "${name}" sorts the whole table unfiltered. Plan:\n${plan}`);
  }
});

test("the chain-filtered view stays index-served too", SKIP, async () => {
  if ((await rowCount()) < 1_000) {
    assert.ok(true, "too few rows seeded -- plan shape not asserted");
    return;
  }
  // 151 must not make the chain-tab case worse. Which index serves it is the
  // planner's call and deliberately NOT asserted here: dropping 151's global
  // index during a mutation check made this fail, which showed the planner
  // prefers the global index even when a chain filter is present (it can
  // walk the order directly and filter as it goes, rather than walking
  // 107's chain-led index and re-sorting the tie-break). Either choice is
  // correct; a scan is not.
  const plan = await planFor(HUB_DEFAULT_ORDER.trim(), `WHERE r.chain_slug = ANY(ARRAY['eth-mainnet'])`);
  assert.doesNotMatch(plan, /Seq Scan/, `the chain tab must stay index-served. Plan:\n${plan}`);
  assert.doesNotMatch(plan, /\bSort\b/, `and must not re-sort. Plan:\n${plan}`);
});

test("151 carries the FULL order key, not just the leading column", () => {
  // An index of the sort column alone would still sort: a btree serves an
  // ORDER BY only for the prefix it stores. This is the mistake that would
  // silently reintroduce the scan.
  const tail = "is_vault_backed DESC, sales_24h DESC NULLS LAST, has_floor DESC, holder_count DESC NULLS LAST, volume_30d_wei DESC NULLS LAST, chain_slug, contract_address";
  for (const column of ["volume_24h_wei", "floor_price_wei", "sales_24h", "floor_change_pct"]) {
    assert.ok(
      MIGRATION.includes(`(${column} DESC NULLS LAST, ${tail})`),
      `plank_market_hub_rank_global_${column}_idx must carry the whole ORDER BY, tie-break included`
    );
  }
  // And none of them leads with chain_slug -- that is exactly what 107's do,
  // and exactly why they cannot serve the unfiltered view.
  for (const line of MIGRATION.split("\n")) {
    if (!line.trim().startsWith("ON plank_market_hub_rank (")) continue;
    assert.doesNotMatch(line, /\(\s*chain_slug/, `a global index must not lead with chain_slug: ${line.trim()}`);
  }
});

test("the mostly-NULL sorts are indexed PARTIALly, and only those", () => {
  // holder_count/listed_count are ~80-85% NULL in production; a full index
  // would be four-fifths entries NULLS LAST never reads. Same call 107 made.
  for (const column of ["holder_count", "listed_count"]) {
    const at = MIGRATION.indexOf(`plank_market_hub_rank_global_${column}_idx`);
    assert.ok(at > 0, `${column} needs a global index too -- otherwise that sort scans`);
    assert.match(MIGRATION.slice(at, at + 600), new RegExp(`WHERE ${column} IS NOT NULL`), `${column}'s global index must be partial`);
  }
  // The dense sorts must NOT be partial: their values are populated, and a
  // partial index there would silently exclude real rows from the order.
  for (const column of ["volume_24h_wei", "floor_price_wei", "floor_change_pct"]) {
    const at = MIGRATION.indexOf(`plank_market_hub_rank_global_${column}_idx`);
    assert.ok(at > 0);
    assert.doesNotMatch(MIGRATION.slice(at, at + 600), /WHERE /, `${column}'s global index must cover every row`);
  }
});

after(closePostgres);
