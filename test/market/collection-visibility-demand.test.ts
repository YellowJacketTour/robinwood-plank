import assert from "node:assert/strict";
import test from "node:test";
import {
  DEMAND_PRIORITY,
  computeVisibilityPriority,
  dedupeAndCapKeys,
  expandRankAdjacency,
} from "../../lib/market/multichain/collection-demand";

// --- DEMAND_PRIORITY bands -------------------------------------------------

test("DEMAND_PRIORITY bands stay in the order the design doc specifies", () => {
  assert.ok(DEMAND_PRIORITY.BACKGROUND < DEMAND_PRIORITY.DETAIL_PAGE);
  assert.ok(DEMAND_PRIORITY.DETAIL_PAGE < DEMAND_PRIORITY.PREDICT_NEXT);
  assert.ok(DEMAND_PRIORITY.PREDICT_NEXT < DEMAND_PRIORITY.VISIBLE);
  assert.ok(DEMAND_PRIORITY.VISIBLE < DEMAND_PRIORITY.VISIBLE_STALE_AGED);
  assert.equal(DEMAND_PRIORITY.VISIBLE, 110);
  assert.equal(DEMAND_PRIORITY.VISIBLE_STALE_AGED, 120);
  assert.equal(DEMAND_PRIORITY.DETAIL_PAGE, 95);
  assert.equal(DEMAND_PRIORITY.BACKGROUND, 50);
});

// --- computeVisibilityPriority (aging boost) -------------------------------

test("computeVisibilityPriority: freshly hydrated visible key stays at plain VISIBLE", () => {
  const now = new Date("2026-08-25T00:10:00Z");
  const priority = computeVisibilityPriority({
    lastHydratedAt: new Date("2026-08-25T00:05:00Z"), // 5 min ago, under the 10 min TTL
    firstVisibleAt: new Date("2026-08-25T00:00:00Z"),
    lastVisibleAt: new Date("2026-08-25T00:09:00Z"),
    now,
  });
  assert.equal(priority, DEMAND_PRIORITY.VISIBLE);
});

test("computeVisibilityPriority: never hydrated ages from first_visible_at, +1 per 2 minutes", () => {
  const firstVisibleAt = new Date("2026-08-25T00:00:00Z");
  // 4 minutes waiting -> floor(4/2) = 2 boost.
  const now = new Date("2026-08-25T00:04:00Z");
  const priority = computeVisibilityPriority({
    lastHydratedAt: null,
    firstVisibleAt,
    lastVisibleAt: firstVisibleAt,
    now,
  });
  assert.equal(priority, DEMAND_PRIORITY.VISIBLE + 2);
});

test("computeVisibilityPriority: stale-past-TTL ages from last_visible_at, not first_visible_at", () => {
  const now = new Date("2026-08-25T01:00:00Z");
  const priority = computeVisibilityPriority({
    lastHydratedAt: new Date("2026-08-25T00:00:00Z"), // 60 min ago, well past the 10 min TTL
    firstVisibleAt: new Date("2026-08-24T00:00:00Z"), // long ago -- must NOT be the anchor once ever-hydrated
    lastVisibleAt: new Date("2026-08-25T00:56:00Z"), // 4 minutes ago -> boost 2
    now,
  });
  assert.equal(priority, DEMAND_PRIORITY.VISIBLE + 2);
});

test("computeVisibilityPriority: boost caps at +10 (never exceeds VISIBLE_STALE_AGED)", () => {
  const now = new Date("2026-08-25T02:00:00Z");
  const priority = computeVisibilityPriority({
    lastHydratedAt: null,
    firstVisibleAt: new Date("2026-01-01T00:00:00Z"), // waited "forever"
    lastVisibleAt: new Date("2026-01-01T00:00:00Z"),
    now,
  });
  assert.equal(priority, DEMAND_PRIORITY.VISIBLE_STALE_AGED);
  assert.equal(priority, 120);
});

test("computeVisibilityPriority: exactly-at-TTL boundary is not yet stale (strictly greater-than only)", () => {
  const lastHydratedAt = new Date("2026-08-25T00:00:00Z");
  const now = new Date("2026-08-25T00:10:00Z"); // exactly 10 minutes, the TTL itself
  const priority = computeVisibilityPriority({
    lastHydratedAt,
    firstVisibleAt: lastHydratedAt,
    lastVisibleAt: lastHydratedAt,
    now,
  });
  assert.equal(priority, DEMAND_PRIORITY.VISIBLE);
});

// --- dedupeAndCapKeys -------------------------------------------------------

test("dedupeAndCapKeys drops blanks, dedupes, and preserves first-seen order", () => {
  const out = dedupeAndCapKeys(["abc", "", "  ", "abc", "def", "abc"]);
  assert.deepEqual(out, ["abc", "def"]);
});

test("dedupeAndCapKeys normalizes 0x-shaped EVM addresses to lowercase for dedup", () => {
  const addr = "0x" + "A".repeat(40);
  const addrLower = "0x" + "a".repeat(40);
  const out = dedupeAndCapKeys([addr, addrLower]);
  assert.deepEqual(out, [addrLower]);
});

test("dedupeAndCapKeys never keeps non-EVM-shaped keys (e.g. Solana mints / Bitcoin ids) case-sensitive", () => {
  const out = dedupeAndCapKeys(["MintABC123", "mintabc123"]);
  assert.deepEqual(out, ["MintABC123", "mintabc123"]);
});

test("dedupeAndCapKeys caps at the given limit (default 40)", () => {
  const many = Array.from({ length: 100 }, (_, i) => `key-${i}`);
  const out = dedupeAndCapKeys(many);
  assert.equal(out.length, 40);
  assert.deepEqual(out, many.slice(0, 40));
});

test("dedupeAndCapKeys honors a custom cap", () => {
  const out = dedupeAndCapKeys(["a", "b", "c", "d"], 2);
  assert.deepEqual(out, ["a", "b"]);
});

test("dedupeAndCapKeys ignores non-string entries defensively", () => {
  const out = dedupeAndCapKeys(["a", null as unknown as string, undefined as unknown as string, "b"]);
  assert.deepEqual(out, ["a", "b"]);
});

// --- expandRankAdjacency ("predict next") ----------------------------------

test("expandRankAdjacency returns +/-2 neighbors of each visible key", () => {
  const pageOrder = ["c0", "c1", "c2", "c3", "c4", "c5", "c6"];
  const out = expandRankAdjacency(["c3"], pageOrder);
  assert.deepEqual(new Set(out), new Set(["c1", "c2", "c4", "c5"]));
});

test("expandRankAdjacency never includes the visible key itself", () => {
  const pageOrder = ["c0", "c1", "c2"];
  const out = expandRankAdjacency(["c1"], pageOrder);
  assert.ok(!out.includes("c1"));
});

test("expandRankAdjacency clamps at the edges of pageOrder without throwing", () => {
  const pageOrder = ["c0", "c1", "c2"];
  const out = expandRankAdjacency(["c0"], pageOrder);
  assert.deepEqual(new Set(out), new Set(["c1", "c2"]));
});

test("expandRankAdjacency ignores visible keys not present in pageOrder", () => {
  const pageOrder = ["c0", "c1", "c2"];
  const out = expandRankAdjacency(["not-in-list"], pageOrder);
  assert.deepEqual(out, []);
});

test("expandRankAdjacency de-duplicates overlapping neighbor windows", () => {
  const pageOrder = ["c0", "c1", "c2", "c3"];
  const out = expandRankAdjacency(["c1", "c2"], pageOrder);
  // c1's own window (radius 2, clamped): c0 (-1), c2 (+1), c3 (+2).
  // c2's own window: c0 (-2), c1 (-1), c3 (+1).
  // Union has no duplicates; each of the two visible keys legitimately
  // appears once too, as the OTHER visible key's own neighbor -- expansion
  // never excludes a key just because it's visible for a different reason.
  assert.equal(out.length, new Set(out).size);
  assert.deepEqual(new Set(out), new Set(["c0", "c1", "c2", "c3"]));
});

test("expandRankAdjacency returns empty for empty inputs", () => {
  assert.deepEqual(expandRankAdjacency([], ["a", "b"]), []);
  assert.deepEqual(expandRankAdjacency(["a"], []), []);
});
