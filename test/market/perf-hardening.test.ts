import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Four optimisations found by a six-way parallel audit, each measured.
 *
 *   1. the hub refetched its entire 698 KB index every 20 s, forever
 *   2. two public `limit` params reached the store unparsed and uncapped
 *   3. two store queries had no LIMIT at all
 *
 * A fourth -- racing the IPFS gateways -- was written and then reverted; see
 * the note below the imports for why that was the right call.
 *
 * Together these are the difference between "fast when warm" and "fast".
 */

const IPFS = readFileSync("lib/ipfs.ts", "utf8").replace(/\r\n/g, "\n");
const HUB = readFileSync("components/market/GlobalMarketHub.tsx", "utf8").replace(/\r\n/g, "\n");
const SWAP = readFileSync("lib/market/swap-orders-store.ts", "utf8").replace(/\r\n/g, "\n");
const BTC = readFileSync("lib/market/bitcoin-listings-store.ts", "utf8").replace(/\r\n/g, "\n");
const BTC_ROUTE = readFileSync(
  "app/api/market/multichain/native-bitcoin-listings/route.ts",
  "utf8"
).replace(/\r\n/g, "\n");

// ------------------------------------------------------------------ gateways
//
// A gateway RACE was written here and then REVERTED, deliberately.
//
// Racing the first two hosts is a real latency win on paper: measured live
// 2026-09-09 the homepage showed a 5,651 ms median with 7 of 10 calls
// returning 500, while gateway.pinata.cloud answered the same bytes in
// 4,478 ms directly. Those were timeouts behind a serial queue.
//
// But test/market/ipfs-gateway-discipline.test.ts asserts maxInFlight === 1,
// under a header that reads "AUDIT Batch F7 -- one gateway per attempt (never
// a 3-way race)". A prior audit removed racing ON PURPOSE, because parallel
// hits on public gateways are what got this app throttled -- lib/ipfs.ts's own
// header records 75 simultaneous requests as the original sin, and a 429 cost
// a 30-minute cooldown.
//
// So the race was not a missing optimisation; it was a decision already made
// against, by someone with production evidence I did not have. The right fix
// for gateway latency is the proof cache (lib/proof-cache.ts): a
// content-addressed body fetched ONCE, ever, needs no race at all, because
// the second request never leaves the building.
//
// Left as a comment rather than deleted, so the next person does not
// rediscover the idea and re-break the same invariant.

// ------------------------------------------------------------------ the poll

test("the hub does not poll a hidden tab", () => {
  // A background tab refetching 698 KB every 20 s is pure waste, and the
  // array-identity replacement remounts every card even when nobody is
  // looking.
  assert.match(HUB, /if \(typeof document !== "undefined" && document\.hidden\) return;/,
    "a hidden tab must skip the poll");
  assert.match(HUB, /visibilitychange/, "and must refresh on return, so it is never stale");
});

test("the poll interval is far longer than it was", () => {
  const m = HUB.match(/\}, (\d[\d_]*)\);\s*\n\s*const onVisible/);
  assert.ok(m, "the interval must be findable");
  const ms = Number(m[1]!.replace(/_/g, ""));
  assert.ok(ms >= 60_000, `a 698 KB refetch must not run every 20 s (saw ${ms} ms)`);
});

test("the visibility listener is removed on unmount", () => {
  // A listener that outlives its component keeps a dead closure -- and its
  // captured state -- alive for the life of the page.
  assert.match(HUB, /removeEventListener\("visibilitychange", onVisible\)/,
    "the listener must be cleaned up");
});

// ------------------------------------------------------------------- bounds

test("a public limit param cannot be NaN, Infinity or unbounded", () => {
  // `Number(limitParam)` with no guard let NaN, Infinity and 1e9 all reach a
  // store query that had no LIMIT of its own.
  assert.match(BTC_ROUTE, /Number\.isFinite\(parsed\)/, "the parse must be guarded");
  assert.match(BTC_ROUTE, /Math\.min\(Math\.max\(Math\.trunc\(parsed\), 1\), 200\)/,
    "and clamped to a real ceiling");
});

test("the store queries are bounded independently of their callers", () => {
  // Defence in depth: a future caller that forgets to clamp must not be able
  // to select every row.
  // EVERY ordered query, not just the first. My first version of this test
  // checked only `indexOf(...)` and so read a different, already-bounded
  // function than the one being patched -- it failed while the code was
  // correct. A file with N such queries needs N assertions.
  for (const [name, src] of [["swap", SWAP], ["bitcoin", BTC]] as const) {
    const positions: number[] = [];
    let at = src.indexOf("ORDER BY created_at DESC");
    while (at > 0) {
      positions.push(at);
      at = src.indexOf("ORDER BY created_at DESC", at + 1);
    }
    assert.ok(positions.length > 0, `${name}: an ordered query must exist`);
    for (const pos of positions) {
      assert.match(
        src.slice(pos, pos + 400),
        /LIMIT (\d+|\$\d)/,
        `${name}: every ordered query must carry a LIMIT (at offset ${pos})`
      );
    }
  }
});

/** The clamp, as a pure function, so the boundary values are exercised. */
function clampLimit(raw: string | null): number | undefined {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 200) : undefined;
}

test("the clamp handles every hostile input", () => {
  assert.equal(clampLimit("1e9"), 200, "a huge number clamps to the ceiling");
  assert.equal(clampLimit("Infinity"), undefined, "Infinity is not finite");
  assert.equal(clampLimit("abc"), undefined, "NaN falls back to the default");
  assert.equal(clampLimit("-5"), 1, "a negative clamps to the floor");
  assert.equal(clampLimit("0"), 1, "zero clamps to the floor");
  assert.equal(clampLimit("50.9"), 50, "a fraction truncates");
  assert.equal(clampLimit(null), undefined, "absent means the caller's default");
  assert.equal(clampLimit("50"), 50, "and a sane value passes through");
});
