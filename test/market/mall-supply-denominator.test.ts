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

test("a chain totalSupply far above the venue's project supply is REFUSED", () => {
  const at = LEDGER.indexOf("export async function correctKnownSupplyFromChain");
  assert.ok(at > 0, "found the chain-confirmed writer");
  const fn = LEDGER.slice(at, at + 2200);

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
