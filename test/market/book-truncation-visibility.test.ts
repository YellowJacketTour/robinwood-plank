import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * A partial book must say WHERE it stopped, not only THAT it stopped.
 *
 * MEASURED ON PRODUCTION 2026-09-08, after the archive-read fix took this
 * endpoint from HTTP 504 at 60s to HTTP 200 at 0.37s. Milady Maker still
 * returned:
 *
 *   listings                    1
 *   collection.listedCount    117
 *   sources.opensea           "truncated-at-limit"
 *   excludedNonNativeCurrency   0
 *
 * That combination cannot be diagnosed from outside. "Truncated" is
 * compatible with at least three different bugs:
 *
 *   - upstream returned one order and a cursor (a vendor problem)
 *   - the walk hit its 10-page cap (the book is genuinely huge)
 *   - many orders were fetched and collapsed in the per-token dedup
 *     (one token carrying 117 re-signed orders -- which OpenSea really does,
 *     rotating an order as it nears expiry)
 *
 * Same symptom, three causes, three different fixes. A coverage object that
 * reports a state without the evidence to act on it is the same silent shape
 * as coverage advancing over a filter that matched nothing.
 *
 * These counters separate the cases at a glance and cost nothing: they are
 * numbers the route already has in local variables.
 */

const SRC = readFileSync(
  path.join(process.cwd(), "app/api/market/multichain/listings/route.ts"),
  "utf8",
);

function foreignCoverageBlock(): string {
  // The foreign-EVM path's coverage object -- the one Milady goes through.
  // (The Robinhood path has its own differently-shaped block.)
  const at = SRC.indexOf('sources: { opensea: pagedComplete');
  assert.ok(at > 0, "found the foreign-EVM bookCoverage");
  const start = SRC.lastIndexOf("bookCoverage: {", at);
  // Brace-match to the real end. Slicing to the first "}," stops at the
  // INLINE `sources: { ... },` object and silently returns a truncated block
  // -- a test that reads only part of what it claims to check is the same
  // shape as the bug it is checking for.
  let depth = 0;
  for (let i = start; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced bookCoverage block");
}

test("a partial book reports how far the walk actually got", () => {
  const block = foreignCoverageBlock();
  assert.ok(/pagesWalked:\s*paged\.pages/.test(block), "pages walked must be reported");
  assert.ok(/ordersFetched:\s*rawOrders\.length/.test(block), "raw upstream order count must be reported");
  assert.ok(
    /ordersAfterDedup:\s*orders\.length/.test(block),
    "the post-dedup count separates 'upstream gave one' from 'dedup collapsed many'",
  );
});

test("the three counters are the ones that actually discriminate", () => {
  // A guard that reports numbers nobody can reason about is decoration. These
  // three, together, name the cause:
  const cases = [
    { pagesWalked: 1, ordersFetched: 1, ordersAfterDedup: 1, cause: "upstream returned one order" },
    { pagesWalked: 10, ordersFetched: 1000, ordersAfterDedup: 900, cause: "hit the page cap" },
    { pagesWalked: 2, ordersFetched: 117, ordersAfterDedup: 1, cause: "dedup collapsed to one token" },
  ];
  for (const c of cases) {
    const collapsed = c.ordersFetched > 10 && c.ordersAfterDedup === 1;
    const cap = c.pagesWalked >= 10;
    const thin = c.pagesWalked <= 1 && c.ordersFetched <= 1;
    assert.equal(
      [collapsed, cap, thin].filter(Boolean).length,
      1,
      `${c.cause} must match exactly one signature, not zero or several`,
    );
  }
});

test("the existing honest signals are not replaced by the new ones", () => {
  const block = foreignCoverageBlock();
  // The counters are additive. complete/partial is still the claim the UI
  // reads; losing it while adding diagnostics would trade one blindness for
  // another.
  assert.ok(/complete:\s*pagedComplete/.test(block), "the completeness claim survives");
  assert.ok(/partial:\s*!pagedComplete/.test(block), "the partial flag survives");
  assert.ok(
    /excludedNonNativeCurrency:\s*excludedNonNative/.test(block),
    "the non-native exclusion count survives",
  );
});

test("the pre-migration backup is not slower than it needs to be", () => {
  // MEASURED 2026-09-08: a pre-migration pg_dump took 97 minutes against a
  // pipeline comment that says "40+". Every migration-carrying deploy pays
  // it, and two migrations in a row pay it twice, serialized.
  //
  // --format=custom is single-threaded and cannot use --jobs (that needs
  // --format=directory, which changes the output shape AND the restore
  // command, so it is not a safe drive-by change). Compression level is safe:
  // same format, same pg_restore invocation, only the CPU spent squeezing.
  const backup = readFileSync(path.join(process.cwd(), "scripts/backup-postgres.mjs"), "utf8");
  assert.ok(/--format=custom/.test(backup), "format is unchanged: restore must not break");
  const m = /--compress=(\d)/.exec(backup);
  assert.ok(m, "compression level is explicit, not left at zlib's default of 6");
  const level = Number(m![1]);
  assert.ok(level >= 1, "level 0 would store uncompressed and balloon the 14 kept dumps");
  assert.ok(level <= 3, `level ${level} is back in the slow band this change exists to leave`);
  // And the safety property that makes trading disk for time acceptable.
  assert.ok(
    /PLANK_BACKUP_KEEP/.test(backup) || /BACKUP_KEEP/.test(backup),
    "retention must bound the extra disk a lower compression level costs",
  );
});

test("criteria orders are excluded from a per-token grid, and counted", () => {
  // MEASURED LIVE 2026-09-08 on Milady Maker, AFTER the diagnostics shipped:
  //
  //   ordersFetched 200   ordersAfterDedup 2   excludedNonNativeCurrency 0
  //   listedCount 117
  //
  // Two "tokens" out of two hundred orders is not a market, it is a key
  // collision. The dedup keys on offer[0].identifierOrCriteria to keep the
  // cheapest ask per token, but for a Seaport CRITERIA order (itemType 4/5)
  // that field is a merkle root shared by every order in the set -- so they
  // all land on one key and the grid renders a handful of rows.
  //
  // The same page read 35 a few hours earlier, so the collapse tracks whatever
  // mix of order types OpenSea happens to return. That variability is exactly
  // why it went unnoticed: the symptom moves.
  //
  // foreign-fulfill.ts already refuses to fulfil anything that is not itemType
  // 2 or 3. The grid must apply the same rule, or it shows cards that the buy
  // path would reject.
  const src = readFileSync(
    path.join(process.cwd(), "app/api/market/multichain/listings/route.ts"),
    "utf8",
  );
  // Start at the constants, which are declared just ABOVE the map: a window
  // that begins at `const cheapestByToken` misses them and reports them
  // missing when they are right there.
  //
  // Bound on the loop's real END, not a character count. This was `at + 2400`
  // and broke the moment explanatory comments were added inside the loop --
  // the assertions failed while the code was correct, which is the same
  // fixed-offset mistake this codebase has now hit repeatedly. The dedup loop
  // ends where the sorted `orders` array is built; that is a real terminator.
  const at = src.indexOf("const ERC721 = 2");
  assert.ok(at > 0, "found the itemType constants");
  const loopEnd = src.indexOf("const orders = [...cheapestByToken.values()]", at);
  assert.ok(loopEnd > at, "found the end of the dedup loop");
  const loop = src.slice(at, loopEnd);

  assert.ok(
    /itemType !== ERC721 && itemType !== ERC1155/.test(loop),
    "a criteria order has no single token id and cannot be a per-token card",
  );
  assert.ok(
    /excludedCriteria \+= 1/.test(loop),
    "excluded orders must be COUNTED: a short grid needs the number that explains it",
  );
  // And the same itemType constants the fulfil path uses, not a second opinion.
  assert.ok(/const ERC721 = 2/.test(loop) && /const ERC1155 = 3/.test(loop));
});

test("the criteria count reaches the caller", () => {
  const src = readFileSync(
    path.join(process.cwd(), "app/api/market/multichain/listings/route.ts"),
    "utf8",
  );
  assert.ok(
    /excludedCriteriaOrders:\s*excludedCriteria/.test(src),
    "counting it internally and not reporting it just moves the blindness",
  );
});
