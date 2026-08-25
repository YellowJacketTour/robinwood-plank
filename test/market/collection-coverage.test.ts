import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCollectionCoverage,
  isFullyIndexedCoverage,
  isCoverageCtaDegraded,
  coverageCtaReason,
  relativeAsOf,
  coverageShortLabel,
} from "../../lib/market/multichain/collection-coverage";
import { primaryVenueForCollection, venueById, COVERAGE_STYLE, COVERAGE_LABEL } from "../../lib/market/multichain/venue-registry";

test("resolveCollectionCoverage matches an exact venue id first", () => {
  const info = resolveCollectionCoverage("eth-mainnet", "blur");
  assert.ok(info);
  assert.equal(info!.venueId, "blur");
  assert.equal(info!.coverage, "partial");
});

test("resolveCollectionCoverage falls back to the chain's worst-case venue when no candidate id matches", () => {
  const info = resolveCollectionCoverage("bitcoin-mainnet", "not-a-real-venue-id");
  assert.ok(info);
  // Bitcoin has multiple registered venues, including several "planned" --
  // worst-case resolution must surface one of those, not silently default
  // to whichever venue happens to sort first.
  assert.ok(info!.coverage === "planned" || info!.coverage === "unavailable");
});

test("resolveCollectionCoverage falls back to a generic EVM venue for an unrecognized eth-family chain slug (chain-agnostic venues have an empty chainSlugs list)", () => {
  const info = resolveCollectionCoverage("some-unregistered-evm-chain", null);
  assert.ok(info);
  assert.notEqual(info!.coverage, "indexed");
});

test("the Marketplank native venue resolves as indexed", () => {
  const info = resolveCollectionCoverage("robinhood", "marketplank");
  assert.ok(info);
  assert.equal(info!.coverage, "indexed");
  assert.equal(isFullyIndexedCoverage(info!.coverage), true);
});

test("isFullyIndexedCoverage is true only for indexed, including null/undefined", () => {
  assert.equal(isFullyIndexedCoverage("indexed"), true);
  assert.equal(isFullyIndexedCoverage("partial"), false);
  assert.equal(isFullyIndexedCoverage("planned"), false);
  assert.equal(isFullyIndexedCoverage("unavailable"), false);
  assert.equal(isFullyIndexedCoverage(null), false);
  assert.equal(isFullyIndexedCoverage(undefined), false);
});

test("isCoverageCtaDegraded flags partial/planned/unavailable, never indexed", () => {
  assert.equal(isCoverageCtaDegraded("indexed"), false);
  assert.equal(isCoverageCtaDegraded("partial"), true);
  assert.equal(isCoverageCtaDegraded("planned"), true);
  assert.equal(isCoverageCtaDegraded("unavailable"), true);
  assert.equal(isCoverageCtaDegraded(null), false);
});

test("coverageCtaReason names the real venue and matches the real coverage level, never a generic warning", () => {
  const partial = coverageCtaReason({ venueId: "opensea-seaport-1.6", venueLabel: "OpenSea / Seaport 1.6", coverage: "partial" });
  assert.match(partial, /partial book data/i);
  assert.match(partial, /OpenSea \/ Seaport 1\.6/);

  const planned = coverageCtaReason({ venueId: "tensor-solana", venueLabel: "Tensor", coverage: "planned" });
  assert.match(planned, /isn't built yet/i);
  assert.match(planned, /Tensor/);

  const unavailable = coverageCtaReason({ venueId: "x2y2", venueLabel: "X2Y2", coverage: "unavailable" });
  assert.match(unavailable, /isn't reachable/i);
  assert.match(unavailable, /X2Y2/);
});

test("relativeAsOf renders honest, rounded age buckets and never fabricates a value for missing input", () => {
  const now = Date.parse("2026-08-24T12:00:00Z");
  assert.equal(relativeAsOf(null, now), null);
  assert.equal(relativeAsOf(undefined, now), null);
  assert.equal(relativeAsOf("not-a-date", now), null);
  assert.equal(relativeAsOf("2026-08-24T11:59:30Z", now), "just now");
  assert.equal(relativeAsOf("2026-08-24T11:48:00Z", now), "12m ago");
  assert.equal(relativeAsOf("2026-08-24T09:00:00Z", now), "3h ago");
  assert.equal(relativeAsOf("2026-08-21T12:00:00Z", now), "3d ago");
});

test("coverageShortLabel and the shared COVERAGE_STYLE/COVERAGE_LABEL maps cover every coverage level", () => {
  for (const level of ["indexed", "partial", "planned", "unavailable"] as const) {
    assert.ok(coverageShortLabel(level).length > 0);
    assert.ok(COVERAGE_STYLE[level].length > 0);
    assert.ok(COVERAGE_LABEL[level].length > 0);
  }
});

test("primaryVenueForCollection and venueById agree on a known venue", () => {
  const venue = venueById("sudoswap");
  assert.ok(venue);
  assert.equal(primaryVenueForCollection("eth-mainnet", "sudoswap")?.id, venue!.id);
});
