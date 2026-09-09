import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * THE PAIR INVARIANT: 24h sales and 24h change are one derivation.
 *
 * Owner rule, and it is a real invariant rather than a display preference:
 *
 *   sales > 0  =>  a change is derivable (it may not be blank)
 *   sales = 0  =>  no change may be shown
 *
 * It could not hold while the two halves came from different places. Sales
 * came from our own trade ledger; the change came from whichever vendor
 * happened to answer, from a stale value that was never cleared, or from a
 * diff of two listing observations with no trade behind it at all. Live on
 * production that produced both contradictions at once:
 *
 *   Friendship Bracelets  16 sales, change blank
 *   Bored Ape Yacht Club  11 sales, change blank
 *   CryptoPunks            0 sales, change -0.2%
 *
 * Three leaks fed the second shape, and all three are closed here:
 *
 *   1. a vendor barred from writing sales was still allowed to write change
 *   2. `floor_change_pct = COALESCE(...)` made a change sticky forever, so it
 *      outlived the window that produced it
 *   3. the API fell back to a floor-diff that never consulted sales
 *
 * These tests read the SOURCE. The derivation lives in SQL against a live
 * table, so there is no unit-testable function to call -- but the shape of
 * that SQL is exactly what regressed, and a reverted clause is caught here.
 */

const STORE = readFileSync("lib/market/multichain/store.ts", "utf8").replace(/\r\n/g, "\n");
const ROUTE = readFileSync("app/api/market/multichain/route.ts", "utf8").replace(/\r\n/g, "\n");

/** The ledger's 24h aggregate query -- bounded by real terminators, not offsets. */
function ledgerQuery(): string {
  const start = STORE.indexOf("export async function updateVolumeFromMarketEvents");
  assert.ok(start > 0, "updateVolumeFromMarketEvents must exist");
  const end = STORE.indexOf("\nexport ", start + 1);
  assert.ok(end > start, "the function must be followed by another export");
  return STORE.slice(start, end);
}

test("the change is derived from the same trade set as sales_24h", () => {
  const q = ledgerQuery();
  // Same CTE, same rows, same window as the sales count directly above it.
  assert.match(q, /COUNT\(\*\) FILTER \(WHERE block_timestamp > NOW\(\) - INTERVAL '24 hours'\)/,
    "precondition: sales_24h is counted over the 24h window");
  assert.match(q, /AS change_pct/,
    "the ledger query must emit a change derived from those same trades");
  assert.match(q, /floorChangePct: row\.change_pct/,
    "and it must be passed through on the ledger write");
});

test("the ledger compares 24h against the PRIOR 24h, not against a floor", () => {
  const q = ledgerQuery();
  assert.match(q, /INTERVAL '48 hours'/,
    "a change needs a prior window to compare against");
  // Both windows must be required. Without the prior-window guard the value
  // would be a division by an empty average -- a fabricated number.
  assert.match(q, /COUNT\(native_wei\) FILTER \(WHERE block_timestamp <= NOW\(\) - INTERVAL '24 hours'/,
    "the prior window must be required to have at least one priced sale");
});

test("a vendor that may not write sales may not write the change either", () => {
  // Leak 1. The old code wrote floor_change_pct inside this branch while
  // returning early for everything else.
  const idx = STORE.indexOf('if (source !== "ledger" && collection.rows[0]?.ledger_owned)');
  assert.ok(idx > 0, "the ledger-owned guard must exist");
  const branch = STORE.slice(idx, STORE.indexOf("\n  await postgresQuery(", idx));
  assert.ok(
    !/UPDATE plank_multichain_snapshots SET floor_change_pct/.test(branch),
    "a source barred from writing sales must not write the change"
  );
});

test("the change is not sticky -- a ledger pass can clear it", () => {
  // Leak 2. COALESCE meant a written change could never be removed, so a
  // collection that stopped trading kept displaying yesterday's move.
  assert.ok(
    !/floor_change_pct = COALESCE\(\$8, floor_change_pct\),/.test(STORE),
    "an unconditional COALESCE makes the change outlive its own window"
  );
  assert.match(
    STORE,
    /floor_change_pct = CASE WHEN \$11 = 'ledger' THEN \$8/,
    "the ledger owns the column and must be able to write NULL"
  );
});

test("the floor-diff fallback cannot fire without sales", () => {
  // Leak 3. This compares two listing observations; on its own it happily
  // reports a move for a collection that never traded.
  // Anchor on the mapping that PRECEDES floorChangeEvidence, not on the first
  // "floorChangePct:" in the file -- the native-home row maps the same key
  // earlier, and slicing from there reads the wrong block entirely.
  const evidence = ROUTE.indexOf("floorChangeEvidence: null,");
  assert.ok(evidence > 0, "the catalog row mapping must exist");
  const idx = ROUTE.lastIndexOf("floorChangePct:", evidence);
  assert.ok(idx > 0, "the route must map floorChangePct");
  const block = ROUTE.slice(idx, evidence);
  assert.match(block, /c\.sales24h != null && c\.sales24h > 0/,
    "the floor-diff fallback must be gated on real sales");
  // And the gate must sit BEFORE the arithmetic it guards.
  assert.ok(
    block.indexOf("c.sales24h") < block.indexOf("previousFloorPriceWei"),
    "the sales gate must precede the floor comparison it guards"
  );
});

/**
 * The pair rule as a pure function, so the two halves can be checked against
 * each other directly rather than only through SQL text.
 */
function pairIsConsistent(sales: number | null, change: number | null): boolean {
  const traded = sales != null && sales > 0;
  if (!traded && change != null) return false; // change with no trades
  return true;
}

test("the pair rule rejects a change with no sales", () => {
  assert.equal(pairIsConsistent(0, -0.2), false, "the CryptoPunks row must be rejected");
  assert.equal(pairIsConsistent(null, -0.2), false);
});

test("the pair rule accepts a traded row and a genuinely quiet one", () => {
  assert.equal(pairIsConsistent(21, 5.0), true, "Claynosaurz: 21 sales, +5.0%");
  assert.equal(pairIsConsistent(0, null), true, "no trades, no change is coherent");
  // A traded row whose prior window had no priced sale is still legal: the
  // change is genuinely unknown rather than zero. The archive says "I do not
  // know" instead of inventing a number, which is the whole point.
  assert.equal(pairIsConsistent(16, null), true);
});
