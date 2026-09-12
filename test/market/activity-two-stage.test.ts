import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * MultichainCollectionView fetched `limit=500` of activity unconditionally on
 * every collection page load. The Activity panel that renders those rows is
 * tab-gated (`active={tab === "activity"}`) and the default tab is
 * "buy-sell", so on first paint almost none of them are shown -- yet the
 * request competes with the token grid and the book for PGPOOL_MAX=4.
 *
 * It cannot simply be deferred to the tab: `saleEvents` derives the
 * always-visible stat bar from it (window volume, highest sale, wash-trade
 * signal), so a page with no activity would render those as empty rather than
 * as loading. Hence a small head page first, then the full tail on idle.
 *
 * WHAT IS TESTED HERE, AND WHAT IS NOT
 * ------------------------------------
 * The ordering guard is the only part with real failure risk, so it is tested
 * as pure logic below -- extracted exactly as written in the component.
 *
 * The wiring (two limits, idle scheduling, a fallback for browsers without
 * requestIdleCallback) is asserted against the source text. That is weaker
 * than driving the component, which would need a DOM and a 3,557-line render;
 * it is included because a regression that silently restores `limit=500` on
 * first paint is invisible otherwise, and this catches it in CI.
 */

const SRC = readFileSync(
  new URL("../../components/market/MultichainCollectionView.tsx", import.meta.url),
  "utf8"
);

/**
 * THE GUARD, copied verbatim from the component's tail handler.
 *
 * Both requests are cached independently (activity/route.ts keys its edgeRead
 * on `variant: { limit }`), so a cached head response can resolve AFTER the
 * tail. Without this guard that late arrival would shrink a rendered 500-row
 * window back to 50 -- the stat bar would visibly lose volume and the highest
 * sale would change, for no reason the viewer can see.
 */
const applyPage = (prev: number, incoming: number): number =>
  incoming >= prev ? incoming : prev;

test("the tail replaces the head, because it is longer", () => {
  assert.equal(applyPage(50, 500), 500);
});

test("a late head response cannot shrink an already-rendered tail", () => {
  assert.equal(
    applyPage(500, 50),
    500,
    "a cached head arriving after the tail must not drop 450 rows out of the stat bar"
  );
});

test("an equal-length response still applies, so fresher data of the same size wins", () => {
  assert.equal(applyPage(500, 500), 500);
});

test("an empty response cannot blank a populated window", () => {
  assert.equal(applyPage(120, 0), 120, "a failed or empty refetch must not erase what is shown");
});

test("the head page is smaller than the full page, and both are within the route's cap", () => {
  const head = Number(/const ACTIVITY_HEAD = (\d+)/.exec(SRC)?.[1]);
  const full = Number(/const ACTIVITY_FULL = (\d+)/.exec(SRC)?.[1]);
  assert.ok(Number.isFinite(head) && Number.isFinite(full), "both limits must be declared as constants");
  assert.ok(head < full, `the head page (${head}) must be smaller than the full page (${full})`);
  assert.ok(
    full <= 500,
    "activity/route.ts clamps limit to 500; asking for more silently returns 500 and misleads the reader"
  );
  assert.ok(head > 0, "a zero head page would render the stat bar as empty rather than as loading");
});

test("first paint requests the head, not the full page", () => {
  // The regression this guards: someone inlines the limit back to 500 in
  // loadActivity and first paint quietly returns to the old behaviour.
  const loadActivity = /const loadActivity = useCallback\(async \(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/.exec(SRC)?.[0] ?? "";
  assert.ok(loadActivity.length > 0, "loadActivity must exist for this assertion to mean anything");
  assert.match(
    loadActivity,
    /fetchActivityPage\(ACTIVITY_HEAD\)/,
    "the first-paint load must request the head page"
  );
  assert.doesNotMatch(
    loadActivity,
    /limit=500|ACTIVITY_FULL/,
    "the first-paint load must not request the full page"
  );
});

test("the tail is deferred to idle, with a fallback for browsers lacking requestIdleCallback", () => {
  assert.match(SRC, /requestIdleCallback/, "the tail must wait for idle so it never competes with first paint");
  assert.match(
    SRC,
    /setTimeout\(run,/,
    "Safari's older baseline has no requestIdleCallback; without a fallback the tail would never arrive there"
  );
  assert.match(SRC, /cancelIdleCallback/, "an unmounted page must not leave a scheduled fetch behind");
});

test("activityLoading is cleared by the head, not the tail", () => {
  // Clearing it only after the full page would mean the split bought nothing:
  // the page would still show a loading state until 500 rows landed.
  const loadActivity = /const loadActivity = useCallback\(async \(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/.exec(SRC)?.[0] ?? "";
  assert.match(
    loadActivity,
    /setActivityLoading\(false\)/,
    "the head handler must clear the loading flag -- that is the point of the split"
  );
});
