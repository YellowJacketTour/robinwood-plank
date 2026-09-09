import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Archive depth must never be measured against a MALL.
 *
 * A multiplex core -- Art Blocks, Manifold, Engine, shared 1155 factories --
 * hosts many projects behind one contract address, and its `totalSupply()`
 * counts the whole mall. `correctKnownSupplyFromChain` called that read
 * "authoritative ground truth", REPLACED known_supply with it outright, and
 * set known_supply_chain_confirmed = TRUE, which then blocks every other
 * correction path. One bad write curses the row for its lifetime.
 *
 * MEASURED ON PRODUCTION 2026-09-08. Friendship Bracelets by Alexis Andre
 * (eth-mainnet 0x942bc2d3e7a589fe5bd4a5c6ef9727dfd82f5c8a, Art Blocks
 * Explorations), from one `/collection` response:
 *
 *   totalSupply (venue)      38,965
 *   knownSupply (archive) 2,000,335   <- 51x larger, the shared core
 *   tokensEverHydrated       39,153   <- MORE than the project has tokens
 *   archivalScore             1.957%   = 39,153 / 2,000,335
 *
 * The tell is `tokensEverHydrated > project supply`: the archive had already
 * hydrated that project completely and was reporting 2%. Not a cosmetic bug --
 * completeness compares COUNT(*) against known_supply, so metadata jobs for a
 * malled collection can never finish and hold a lane forever.
 *
 * This is the shared-storefront failure the cluster layer refuses in HOST
 * space, appearing in TOKEN-ID space instead. `uriPrefix` cannot see it.
 */

const ROOT = process.cwd();
const LEDGER = readFileSync(
  path.join(ROOT, "lib/market/multichain/archival-ledger.ts"),
  "utf8",
);
const MIGRATIONS = path.join(ROOT, "deploy/inmotion/postgres/migrations");

/**
 * The source from `from` to a REAL boundary, never a fixed offset.
 *
 * These reads used `slice(at, at + 2200)` and `slice(at, at + 2600)`. Adding
 * a comment to the guarded function pushed MALL_SUPPLY_RATIO from character
 * 1,563 to 2,360 -- past the window -- and the test reported "no mall guard"
 * about a guard that was present, correct, and running before the write.
 *
 * A character count is not a boundary. It encodes today's comment density as
 * if it were a fact about the code, so any edit to the prose can fail the
 * test while the behaviour is untouched -- and, far worse, a window that runs
 * LONG silently reads a neighbouring function and can pass on the wrong
 * code's text.
 */
function sourceFrom(from: number, ...stops: string[]): string {
  assert.ok(from > 0, "the anchor must exist");
  let end = LEDGER.length;
  for (const stop of stops) {
    const at = LEDGER.indexOf(stop, from + 1);
    if (at > from && at < end) end = at;
  }
  return LEDGER.slice(from, end);
}

test("a chain totalSupply far above the venue's project supply is REFUSED", () => {
  const at = LEDGER.indexOf("export async function correctKnownSupplyFromChain");
  assert.ok(at > 0, "found the chain-confirmed writer");
  const fn = sourceFrom(at, "\nexport ");

  // The cross-check must happen BEFORE the write, or the row is already cursed.
  const guardAt = fn.indexOf("MALL_SUPPLY_RATIO");
  const writeAt = fn.indexOf("known_supply_chain_confirmed = TRUE");
  assert.ok(guardAt > 0, "no mall guard -- a shared core's supply would be written as truth");
  assert.ok(
    guardAt < writeAt,
    "the guard must run before the UPDATE: chain_confirmed = TRUE cannot be walked back",
  );
  assert.ok(
    /return null;/.test(fn.slice(guardAt, writeAt)),
    "a suspected mall must leave known_supply ALONE rather than write a wrong number",
  );
});

test("the ratio is loose enough not to fire on an ordinary growing collection", () => {
  const m = /const MALL_SUPPLY_RATIO = (\d+)/.exec(LEDGER);
  assert.ok(m, "the threshold is a named constant");
  const ratio = Number(m![1]);
  // A venue's total_supply legitimately lags a live mint, so a tight ratio
  // would refuse real chain reads on healthy collections. A mall is off by
  // orders of magnitude (51x in the measured case), not by a factor of two.
  assert.ok(ratio >= 2, `ratio ${ratio} would fire on ordinary mint lag`);
  assert.ok(ratio <= 10, `ratio ${ratio} is loose enough to let a real mall through`);
});

test("the measured Art Blocks case is caught, and a normal collection is not", () => {
  const m = /const MALL_SUPPLY_RATIO = (\d+)/.exec(LEDGER);
  const ratio = Number(m![1]);
  const isMall = (chain: number, venue: number) => chain > venue * ratio;

  // The real numbers off production.
  assert.equal(isMall(2_000_335, 38_965), true, "Friendship Bracelets must be refused");
  // An ordinary collection whose venue stats lag an active mint.
  assert.equal(isMall(10_400, 10_000), false, "4% mint lag is not a mall");
  assert.equal(isMall(21_931, 21_931), false, "an exact match is the case this read exists for");
  // The bug this whole guard protects: hydrated exceeding project supply.
  assert.ok(39_153 > 38_965, "the tell -- more rows held than the project has tokens");
});

test("a migration un-curses rows already written with a mall's supply", () => {
  const sql = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8"))
    .join("\n");

  // The guard only stops NEW bad writes. Friendship Bracelets is already
  // cursed, and chain_confirmed = TRUE blocks every other correction path.
  assert.ok(
    /UPDATE collection_archival_stats[\s\S]{0,1200}known_supply = NULL/.test(sql),
    "no migration clears an already-cursed denominator",
  );
  assert.ok(
    /known_supply_chain_confirmed = FALSE/.test(sql),
    "the confirmed flag must drop too, or nothing can ever rewrite the value",
  );
  // It must NOT invent a replacement: NULL is handled honestly by the scorer
  // as 'unknown_supply', which shows no percentage rather than a wrong one.
  assert.ok(
    !/known_supply = snap\.total_supply/.test(sql),
    "do not substitute the venue's number either -- absence is honest, a guess is not",
  );
});

test("the scorer still refuses to invent a percentage when supply is unknown", () => {
  // The migration NULLs known_supply, so this path is what those rows land on.
  // If it ever fabricated a number, un-cursing a row would replace a wrong
  // percentage with a different wrong percentage.
  assert.ok(
    /scoreMethod: "unknown_supply"/.test(LEDGER) && /NEVER invent a %/.test(LEDGER),
    "an unknown denominator must produce no score at all",
  );
});

test("the id-inference ratchet is ALSO guarded, not just the chain read", () => {
  // THE BUG THIS EXISTS FOR, measured live 2026-09-08.
  //
  // Migration 106 cleared Friendship Bracelets' known_supply and set
  // chain_confirmed = FALSE so a better value could be written. That
  // RE-ENABLED the max-id ratchet, and an Art Blocks token id near 2,038,964
  // immediately rewrote known_supply to 2,000,343 -- LARGER than the
  // 2,000,335 the migration had just cleared.
  //
  // Guarding only correctKnownSupplyFromChain did not fix the row. It
  // unlocked the other vector. Art Blocks encodes
  // tokenId = projectId * 1_000_000 + invocation, so "highest id observed" is
  // a fact about the whole CORE and never about one project.
  const at = LEDGER.indexOf("const observedMaxId");
  assert.ok(at > 0, "found the id-inference ratchet");
  const block = sourceFrom(at, "\nexport ", "\nfunction ");

  assert.ok(
    /inferenceIsMall/.test(block),
    "the ratchet must apply the same mall test as the chain read",
  );
  assert.ok(
    /MALL_SUPPLY_RATIO/.test(block),
    "and must use the same threshold, not a second opinion",
  );
  assert.ok(
    /!inferenceIsMall &&/.test(block),
    "a mall-shaped inference must not be written",
  );
});

test("a row already carrying a mall's number is cleared by the read path", () => {
  // A migration alone cannot fix this: the ratchet runs on the very next read
  // and undoes it. The clearing has to live where the ratchet lives.
  const at = LEDGER.indexOf("const observedMaxId");
  const block = sourceFrom(at, "\nexport ", "\nfunction ");
  assert.ok(
    /known_supply = NULL, known_supply_chain_confirmed = FALSE/.test(block),
    "the read path must clear a poisoned denominator, not only refuse new ones",
  );
  // And it must clear to NULL, never to a guess.
  assert.ok(
    !/shape\.knownSupply = venueSupplyForRatchet/.test(block),
    "do not substitute the venue number: absence is honest, a guess is not",
  );
});
