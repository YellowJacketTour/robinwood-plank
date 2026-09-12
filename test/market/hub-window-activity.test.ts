import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  changeHoleKindFor,
  resolveHoleKind,
  volumeHoleKindFor,
  windowSalesDisplay,
  windowVolumeDisplay,
} from "../../lib/market/multichain/window-activity";

/**
 * The hub grid's "not yet" holes that were lying.
 *
 * `not yet` is the `unfetched` TypedHole, and it means exactly one thing:
 * WE HAVE NEVER LOOKED. It is also the only kind isSchedulable() returns true
 * for, so every one of them is a work order the attention beam will pick up.
 * Rendering it over a value we already measured is therefore both a lie to
 * the visitor and a permanent, unsatisfiable job in the queue.
 *
 * THE EVIDENCE THESE TESTS ARE PINNED TO
 * --------------------------------------
 * Fetched from production on 2026-09-12 --
 *   GET https://plank.love/api/market/multichain?limit=12&v=index-3
 *   -> HTTP 200, 24,598 bytes
 *
 * The two rows the bug report named came back like this, verbatim:
 *
 *   RobinWood        chain robinhood, isNativeHome true
 *                    floorPriceWei "9000000000000000"  listedCount 76
 *                    holderCount 298
 *                    sales24h 0        volume24hWei null
 *                    floorChangePct 0  floorChangeStatus "observed-24h"
 *
 *   Beezie - Base    chain base-mainnet, 0xbb5e...a16f
 *                    sales24h 1587  sales7d 11179  sales30d 11179
 *                    volume24hWei null  volume7dWei null  volume30dWei null
 *                    floorChangePct 0   floorChangeStatus "observed-24h"
 *
 * For contrast, from the same response, a row the grid rendered correctly:
 *
 *   FROG HEADS       sales24h 1147  volume24hWei "1467244445367000000"
 *                    floorChangeStatus "collecting-baseline"
 *
 * Every fixture below is one of those literal payloads. They are not
 * invented shapes chosen to make a function pass -- the fixtures came first
 * and the branches were written to them.
 */

/** The RobinWood home row, exactly as production served it. */
const ROBINWOOD = {
  volumeWei: null,
  volumeUsd: null,
  sales: 0,
  floorChangeStatus: "observed-24h" as const,
  floorChangePct: 0,
};

/** The Beezie - Base row, exactly as production served it (24h window). */
const BEEZIE = {
  volumeWei: null,
  volumeUsd: null,
  sales: 1587,
  floorChangeStatus: "observed-24h" as const,
  floorChangePct: 0,
};

/** A row the grid already rendered right, so the fix must not disturb it. */
const FROG_HEADS = {
  volumeWei: "1467244445367000000",
  volumeUsd: null,
  sales: 1147,
  floorChangeStatus: "collecting-baseline" as const,
  floorChangePct: null,
};

// ---------------------------------------------------------------------------
// RobinWood: a counted zero is not an absence
// ---------------------------------------------------------------------------

test("RobinWood's sales24h of 0 is a measured zero, not an unfetched hole", () => {
  // salesStatsFromLedger() read plank_chain_events -- OUR OWN ledger for the
  // home collection -- and counted no sale in the window. That is an answer.
  const display = windowSalesDisplay(ROBINWOOD.sales);
  assert.equal(display.kind, "zero");
  // The distinction that matters: `zero` must never be reported as the kind
  // that means "nobody has looked", because the beam would then queue the
  // home collection forever to re-derive a number it already has.
  assert.notEqual(display.kind, "absent");
});

test("a sales count that was never computed stays absent, unlike a counted zero", () => {
  // The whole point of the fix is that these two are DIFFERENT. If the
  // implementation folded them together again (the original bug: `n === 0`
  // mapped to null alongside `n == null`) this assertion is what catches it.
  assert.equal(windowSalesDisplay(null).kind, "absent");
  assert.equal(windowSalesDisplay(undefined).kind, "absent");
  assert.notEqual(windowSalesDisplay(0).kind, windowSalesDisplay(null).kind);
});

test("a positive sales count is rendered as itself, not routed through a hole", () => {
  const display = windowSalesDisplay(BEEZIE.sales);
  assert.equal(display.kind, "count");
  assert.equal(display.kind === "count" && display.sales, 1587);
});

test("RobinWood's zero sales make its zero volume a measured zero too", () => {
  // No sales in the window means no volume in the window. That is arithmetic,
  // not a gap, so the volume cell must not claim it was never fetched either.
  assert.equal(windowVolumeDisplay(ROBINWOOD).kind, "zero");
  assert.equal(volumeHoleKindFor(ROBINWOOD), "none");
  assert.notEqual(volumeHoleKindFor(ROBINWOOD), "unfetched");
});

// ---------------------------------------------------------------------------
// RobinWood: the change cell's fall-through
// ---------------------------------------------------------------------------

test("an observed-24h floor change can never be classified as unfetched", () => {
  // This is the exact production state that made RobinWood the ONLY row in
  // the grid showing "not yet" for change while all eleven others showed
  // "collecting baseline". The server said observed-24h -- two real floor
  // observations 24 h apart, both 0.009 ETH -- and the render still fell
  // through to the never-looked hole.
  const kind = changeHoleKindFor({
    floorChangeStatus: ROBINWOOD.floorChangeStatus,
    rawChangePct: ROBINWOOD.floorChangePct,
    sales: ROBINWOOD.sales,
  });
  assert.notEqual(kind, "unfetched");
  // Both endpoints measured the same floor, so the honest statement is that
  // the floor did not move -- a real 0.0%, which is the `none` kind.
  assert.equal(kind, "none");
});

test("an unobserved floor with no sales is genuinely unfetched", () => {
  // The fix must not make `unfetched` unreachable. A row with no floor
  // observation at all and nothing traded really has never been looked at,
  // and the beam SHOULD queue it.
  assert.equal(
    changeHoleKindFor({ floorChangeStatus: null, rawChangePct: null, sales: null }),
    "unfetched",
  );
  assert.equal(
    changeHoleKindFor({ floorChangeStatus: null, rawChangePct: null, sales: 0 }),
    "unfetched",
  );
});

test("a collecting-baseline row stays underived, matching what the grid already showed", () => {
  // FROG_HEADS and nine other rows rendered "collecting baseline" and that
  // was correct. Re-fetching cannot supply a second endpoint in time.
  assert.equal(
    changeHoleKindFor({
      floorChangeStatus: FROG_HEADS.floorChangeStatus,
      rawChangePct: FROG_HEADS.floorChangePct,
      sales: FROG_HEADS.sales,
    }),
    "underived",
  );
});

test("an observed-24h row with a non-zero suppressed change is underived, not none", () => {
  // `none` renders "0" -- a claim the floor was flat. It may only be made
  // when the measured change actually WAS zero. A non-zero measurement that
  // the display layer suppressed for some other reason must not be relabelled
  // as a flat tape.
  assert.equal(
    changeHoleKindFor({ floorChangeStatus: "observed-24h", rawChangePct: -3.2, sales: 5 }),
    "underived",
  );
  assert.equal(
    changeHoleKindFor({ floorChangeStatus: "observed-24h", rawChangePct: null, sales: 5 }),
    "underived",
  );
});

// ---------------------------------------------------------------------------
// Beezie: sales present, native volume absent
// ---------------------------------------------------------------------------

test("Beezie's 1587 counted sales with no native sum is underived, never unfetched", () => {
  // 11,179 recorded sales over 30 days and zero wei in every window is not a
  // lane that never ran. updateVolumeFromMarketEvents computes COUNT(*) and
  // SUM(native_wei) in ONE query; native_wei is deliberately NULL for a fill
  // settled in a non-native currency. So the count survives and the sum does
  // not, and re-running the same lane produces the same NULL forever.
  //
  // `unfetched` would put this row in the schedulable queue permanently.
  assert.equal(volumeHoleKindFor(BEEZIE), "underived");
  assert.notEqual(volumeHoleKindFor(BEEZIE), "unfetched");
});

test("the stored USD sum is served as a real value rather than a hole", () => {
  // The same aggregation already computes SUM(amount_usd) over EVERY sale
  // regardless of denomination and writes it to volume_24h_usd. Until this
  // change nothing read that column, so the figure was computed on every
  // ledger pass and discarded while the cell said "not yet" on top of it.
  const display = windowVolumeDisplay({ ...BEEZIE, volumeUsd: "412350.75" });
  assert.equal(display.kind, "usd");
  assert.equal(display.kind === "usd" && display.usd, 412350.75);
  assert.equal(display.kind === "usd" && display.sales, 1587);
});

test("a native sum outranks a USD sum -- precision wins, and no conversion is invented", () => {
  // When both exist the native figure is the more precise measurement and is
  // the one denominated in the coin the chain icon claims. The USD path must
  // never take over a row that has a real wei total.
  const display = windowVolumeDisplay({
    volumeWei: FROG_HEADS.volumeWei,
    volumeUsd: "3900.5",
    sales: FROG_HEADS.sales,
  });
  assert.equal(display.kind, "native");
  assert.equal(display.kind === "native" && display.wei, "1467244445367000000");
});

test("a zero or unparseable wei total is not treated as a native sum", () => {
  // nonzeroWei() upstream already normalises "0" to NULL, but the hub also
  // receives rows from the live-change snapshot route and from its own
  // placeholder, so the render path must not trust the column blindly.
  assert.notEqual(windowVolumeDisplay({ volumeWei: "0", volumeUsd: null, sales: 4 }).kind, "native");
  assert.notEqual(windowVolumeDisplay({ volumeWei: "", volumeUsd: null, sales: 4 }).kind, "native");
  assert.notEqual(
    windowVolumeDisplay({ volumeWei: "not-a-number", volumeUsd: null, sales: 4 }).kind,
    "native",
  );
});

test("a zero or unparseable USD total is not shown as a dollar figure", () => {
  // Showing "$0.00" for a collection with 1,587 sales would be a confident
  // wrong number -- strictly worse than the honest hole it replaced.
  assert.notEqual(windowVolumeDisplay({ ...BEEZIE, volumeUsd: "0" }).kind, "usd");
  assert.notEqual(windowVolumeDisplay({ ...BEEZIE, volumeUsd: "" }).kind, "usd");
  assert.notEqual(windowVolumeDisplay({ ...BEEZIE, volumeUsd: "NaN" }).kind, "usd");
  assert.notEqual(windowVolumeDisplay({ ...BEEZIE, volumeUsd: "-12" }).kind, "usd");
});

test("a row with neither sum and no counted sales is still genuinely unfetched", () => {
  // The escape hatch must stay open, or the beam loses the only signal it has
  // for rows that really do need fetching.
  assert.equal(
    volumeHoleKindFor({ volumeWei: null, volumeUsd: null, sales: null }),
    "unfetched",
  );
  assert.equal(windowVolumeDisplay({ volumeWei: null, volumeUsd: null, sales: null }).kind, "absent");
});

// ---------------------------------------------------------------------------
// The join, which a mutation proved was the untested seam
// ---------------------------------------------------------------------------

/**
 * These four tests exist because of a mutation that SURVIVED.
 *
 * Deleting `established ??` from holeFor()'s kind expression reverts every
 * user-visible part of this fix -- RobinWood's counted zero goes straight
 * back to reading "not yet" -- and the suite stayed green. The classifier was
 * covered and the call sites were covered; the single line joining them was
 * not, because holeFor() returns JSX from a "use client" module and cannot be
 * driven by a node:test. The rule moved into resolveHoleKind() so that the
 * join itself is executable, and these drive it.
 */
test("an established kind overrides the generic classification", () => {
  // The mutation, expressed as an assertion: if the established kind is
  // dropped, this returns the fallback and the fix is silently gone.
  assert.equal(
    resolveHoleKind({ chainHasNoSource: false, established: "none", fallback: "unfetched" }),
    "none",
  );
  assert.equal(
    resolveHoleKind({ chainHasNoSource: false, established: "underived", fallback: "unfetched" }),
    "underived",
  );
});

test("with nothing established, the generic classification still decides", () => {
  // The listed and holders columns pass no established kind at all and must
  // keep behaving exactly as they did before this change.
  assert.equal(
    resolveHoleKind({ chainHasNoSource: false, established: undefined, fallback: "unfetched" }),
    "unfetched",
  );
  assert.equal(
    resolveHoleKind({ chainHasNoSource: false, established: undefined, fallback: "underived" }),
    "underived",
  );
});

test("an unsourced chain outranks anything the row establishes", () => {
  // Solana and Bitcoin holder counts have no endpoint on Helius DAS or
  // UniSat/Ordiscan. No row data can make such a field sourceable, and
  // calling it `unfetched` would queue beam work that can never succeed.
  assert.equal(
    resolveHoleKind({ chainHasNoSource: true, established: "none", fallback: "unfetched" }),
    "unsourced",
  );
  assert.equal(
    resolveHoleKind({ chainHasNoSource: true, established: "underived", fallback: "underived" }),
    "unsourced",
  );
});

test("end to end: RobinWood's live row resolves to a rendered zero, not a work order", () => {
  // The whole bug, from the production payload to the kind the cell renders,
  // through the same two functions the component calls in that order.
  const salesKind = resolveHoleKind({
    chainHasNoSource: false,
    established: windowSalesDisplay(ROBINWOOD.sales).kind === "zero" ? "none" : undefined,
    fallback: "unfetched",
  });
  assert.equal(salesKind, "none");

  const changeKind = resolveHoleKind({
    chainHasNoSource: false,
    established: changeHoleKindFor({
      floorChangeStatus: ROBINWOOD.floorChangeStatus,
      rawChangePct: ROBINWOOD.floorChangePct,
      sales: ROBINWOOD.sales,
    }),
    fallback: "unfetched",
  });
  assert.equal(changeKind, "none");

  const volumeKind = resolveHoleKind({
    chainHasNoSource: false,
    established: volumeHoleKindFor(ROBINWOOD),
    fallback: "unfetched",
  });
  assert.equal(volumeKind, "none");

  // And Beezie, whose sales are real and whose native sum genuinely is not.
  assert.equal(
    resolveHoleKind({
      chainHasNoSource: false,
      established: volumeHoleKindFor(BEEZIE),
      fallback: "unfetched",
    }),
    "underived",
  );
});

// ---------------------------------------------------------------------------
// The wiring: the modules that must actually consume the classification
// ---------------------------------------------------------------------------

test("the store SELECTs the USD volume columns it has always written", () => {
  // Grepping `volume_24h_usd` across the repo on 2026-09-12 returned four
  // hits, all in store.ts, all writes. A column that is written and never
  // read is invisible no matter how correct the derivation above is, so this
  // asserts the read side exists.
  const store = readFileSync(
    new URL("../../lib/market/multichain/store.ts", import.meta.url),
    "utf8",
  );
  assert.match(store, /volume_24h_usd::text AS volume_24h_usd/);
  assert.match(store, /volume_7d_usd::text AS volume_7d_usd/);
  assert.match(store, /volume_30d_usd::text AS volume_30d_usd/);
  // Every query returning CollectionWithSnapshot must carry them, or a caller
  // silently gets undefined and the cell falls back to a hole again.
  const selectSites = store.split("USD_VOLUME_SELECT").length - 1;
  assert.ok(
    selectSites >= 5,
    `expected USD_VOLUME_SELECT at its definition plus every CollectionWithSnapshot query, saw ${selectSites}`,
  );
});

test("the hub route serves the USD volume fields to the client", () => {
  const route = readFileSync(
    new URL("../../app/api/market/multichain/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /volume24hUsd: c\.volume24hUsd/);
  assert.match(route, /volume7dUsd: c\.volume7dUsd/);
  assert.match(route, /volume30dUsd: c\.volume30dUsd/);
});

test("the hub grid renders through the classifier instead of the old wei-only check", () => {
  const hub = readFileSync(
    new URL("../../components/market/GlobalMarketHub.tsx", import.meta.url),
    "utf8",
  );
  // The original volume cell was `if (!vol || vol === "0") return holeFor(c, "volume")`
  // -- a wei-only test that could not see the USD sum or a counted zero.
  assert.doesNotMatch(hub, /if \(!vol \|\| vol === "0"\) return holeFor\(c, "volume"\)/);
  assert.match(hub, /volumeHoleKindFor\(activity\)/);
  assert.match(hub, /changeHoleKindFor\(\{/);
  assert.match(hub, /windowVolumeDisplay\(activity\)/);
  // holeFor must resolve through the shared, testable rule rather than an
  // inline expression -- see the resolveHoleKind block above for the mutation
  // that survived while that logic was inlined here.
  assert.match(hub, /resolveHoleKind\(\{/);
});
