import assert from "node:assert/strict";
import test from "node:test";
import { coverageCellKey, isProvenComplete, summarizeCoverage, type CapabilityCoverageCell } from "../../lib/market/multichain/capability-coverage";

const cell: CapabilityCoverageCell = {
  chainSlug: "eth-mainnet", venueId: "opensea", protocol: "seaport", protocolVersion: "1.6",
  capability: "sales", state: "complete", indexedFrom: "0", indexedThrough: "100", observedHead: "100",
  lastSuccessAt: "2026-08-22T18:00:00Z", evidenceSource: "hypersync",
};

test("coverage identity is chain x venue x version x capability", () => {
  assert.equal(coverageCellKey(cell), "eth-mainnet::opensea::1.6::sales");
});

test("complete requires a contiguous evidenced range through head", () => {
  assert.equal(isProvenComplete(cell), true);
  assert.equal(isProvenComplete({ ...cell, indexedThrough: "99" }), false);
  assert.equal(isProvenComplete({ ...cell, evidenceSource: null }), false);
  assert.deepEqual(summarizeCoverage([cell, { ...cell, capability: "bids", state: "planned" }]), {
    total: 2, complete: 1, degraded: 0, unknown: 1, percentComplete: 50,
  });
});
