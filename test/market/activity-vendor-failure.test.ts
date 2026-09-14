import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * /api/market/multichain/activity returned 500 when OpenSea rate-limited us.
 *
 * MEASURED ON PRODUCTION 2026-09-12 (curl, CryptoPunks on eth-mainnet):
 *
 *   try1  500  25.4s
 *   try2  200  37.6s
 *   try3  500  19.1s
 *
 * and again on Base: 500 @ 20.6s. Failing two times in three, taking 20-40
 * seconds to do it. The collection page calls this on every load, so the
 * Activity tab could not render and the visitor was told OUR site was broken
 * when what actually happened is that a third party throttled us.
 *
 * The mechanism was one line:
 *
 *     if (!res.ok) throw new Error(`OpenSea ${res.status}`);
 *
 * inside an `edgeRead` whose rejection propagated to the handler's outer
 * catch, which calls publicError -> 500.
 *
 * WHY THE FIX IS NOT A RETRY OR A LONGER TIMEOUT
 * ---------------------------------------------
 * The archive is ALREADY tried first: this branch is only reached when
 * readSeaportFillHistory and the unioned ledger both came back empty. So the
 * vendor is the fallback, and a fallback that takes the whole route down with
 * it is worse than no fallback at all. An empty feed that says why is a usable
 * page; a 500 is not.
 *
 * WHY IT MUST STILL REPORT
 * ------------------------
 * An empty `events` array with no explanation is the same response a
 * collection with genuinely no recent activity produces. Rendering "no
 * activity" over a vendor failure is the exact species of confident lie this
 * codebase refuses everywhere else, so the existing `coverage` object carries
 * `vendorUnavailable` and the real `vendorError` string.
 */

const SRC = readFileSync(
  new URL("../../app/api/market/multichain/activity/route.ts", import.meta.url),
  "utf8"
);

/** The handler's OpenSea fallback, isolated so assertions cannot match elsewhere. */
const FALLBACK = /let data: \{ asset_events\?: OpenSeaEvent\[\] \} = \{\};[\s\S]*?vendorError = error instanceof Error \? error\.message : String\(error\);\s*\}/.exec(SRC)?.[0] ?? "";

test("the OpenSea read is wrapped, so a vendor failure cannot reach the outer catch", () => {
  assert.ok(FALLBACK.length > 0, "the guarded fallback must exist for the rest of this file to mean anything");
  assert.match(FALLBACK, /try \{/, "the edgeRead must be inside a try");
  assert.match(
    FALLBACK,
    /catch \(error\) \{/,
    "and it must catch -- an unguarded rejection is what produced the 500"
  );
});

test("the throw that signalled a bad vendor response is still there", () => {
  // The fix must NOT have been to stop noticing the failure. edgeRead needs
  // the rejection so it does not cache a bad page as if it were good; what
  // changed is only that the route no longer dies on it.
  assert.match(
    SRC,
    /if \(!res\.ok\) throw new Error\(`OpenSea \$\{res\.status\}`\);/,
    "a non-ok response must still reject inside edgeRead, or a 429 body gets cached as data"
  );
});

test("a vendor failure is REPORTED, not silently rendered as 'no activity'", () => {
  assert.match(SRC, /vendorUnavailable: vendorError !== null/, "the coverage object must state that the vendor failed");
  assert.match(SRC, /vendorError,/, "and carry the real reason, not just a boolean");
});

test("the real reason is preserved rather than flattened to 'unavailable'", () => {
  assert.match(
    FALLBACK,
    /error instanceof Error \? error\.message : String\(error\)/,
    "a 429, a DNS failure and a bad slug must stay distinguishable from outside"
  );
});

test("the empty-data default is an object, so the mapper cannot throw on it", () => {
  // `data.asset_events ?? []` runs unconditionally after the catch. If `data`
  // were left undefined the route would still 500, just one line later.
  assert.match(
    FALLBACK,
    /let data: \{ asset_events\?: OpenSeaEvent\[\] \} = \{\};/,
    "data must default to an empty object before the try"
  );
  assert.match(SRC, /\(data\.asset_events \?\? \[\]\)/, "and the mapper must tolerate a missing array");
});

/**
 * The archive-first ordering is the reason this degradation is acceptable. If
 * the vendor were the PRIMARY source, returning an empty feed would be hiding
 * real data rather than reporting a failure of a fallback.
 */
test("the ledger is read BEFORE the vendor, so this is a fallback failing, not the source", () => {
  const ledgerAt = SRC.indexOf("readSeaportFillHistory({ chainSlug, contractAddress, limit })");
  const vendorAt = SRC.indexOf("const keyEntry = await pickOpenSeaKey(\"live\")");
  assert.ok(ledgerAt > 0, "the ledger read must exist");
  assert.ok(vendorAt > 0, "the vendor read must exist");
  assert.ok(
    ledgerAt < vendorAt,
    "the durable ledger must be consulted first -- the vendor is the fallback, not the source"
  );
});

// --- the degradation contract, driven -------------------------------------

/** The exact shape the route now runs: guarded read, empty default, reported. */
async function guardedRead(
  fetchOnce: () => Promise<{ asset_events?: Array<{ id: string }> }>
): Promise<{ events: Array<{ id: string }>; vendorUnavailable: boolean; vendorError: string | null }> {
  let data: { asset_events?: Array<{ id: string }> } = {};
  let vendorError: string | null = null;
  try {
    data = await fetchOnce();
  } catch (error) {
    vendorError = error instanceof Error ? error.message : String(error);
  }
  return {
    events: data.asset_events ?? [],
    vendorUnavailable: vendorError !== null,
    vendorError,
  };
}

test("a 429 yields an empty feed that declares itself unavailable, never a throw", async () => {
  const out = await guardedRead(async () => {
    throw new Error("OpenSea 429");
  });
  assert.deepEqual(out.events, [], "no events, because the vendor gave none");
  assert.equal(out.vendorUnavailable, true, "and the caller is told the vendor is why");
  assert.equal(out.vendorError, "OpenSea 429", "with the status preserved");
});

test("a genuinely empty collection is DISTINGUISHABLE from a vendor failure", async () => {
  const out = await guardedRead(async () => ({ asset_events: [] }));
  assert.deepEqual(out.events, []);
  assert.equal(
    out.vendorUnavailable,
    false,
    "an empty feed from a healthy vendor must not claim the vendor failed -- these are different facts and the UI renders them differently"
  );
  assert.equal(out.vendorError, null);
});

test("a successful read passes its events through untouched", async () => {
  const out = await guardedRead(async () => ({ asset_events: [{ id: "a" }, { id: "b" }] }));
  assert.deepEqual(out.events, [{ id: "a" }, { id: "b" }]);
  assert.equal(out.vendorUnavailable, false);
});

test("a non-Error rejection still produces a usable reason", async () => {
  const out = await guardedRead(async () => {
    throw "socket hang up";
  });
  assert.equal(out.vendorUnavailable, true);
  assert.equal(out.vendorError, "socket hang up", "a thrown string must not become '[object Object]'");
});
