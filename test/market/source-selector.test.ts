import assert from "node:assert/strict";
import test from "node:test";
import { scoreSources, corroborate, lanesFor, providerForSource, costUnitsForSource, type SourceEvidence } from "../../lib/market/multichain/edge/source-selector";
import type { MeshLane } from "../../lib/market/multichain/mesh/matrix";

const lane = (source: MeshLane["source"], chainSlug = "eth-mainnet"): MeshLane => ({ id: `${source}:${chainSlug}`, source, chainSlug, cells: ["floor"], sliceSec: 60, notes: "" });
const ev = (over: Partial<SourceEvidence>): SourceEvidence => ({ jailedMs: 0, budgetPressure: 0, budgetExhausted: false, calls: 0, ok: 0, avgLatencyMs: null, ...over });

test("a jailed source is ineligible and ranks last, with the jail in its reason", () => {
  const ranked = scoreSources([lane("opensea-stats"), lane("coingecko-nft")], new Map([["opensea-stats", ev({ jailedMs: 90_000 })]]));
  assert.equal(ranked[0].lane.source, "coingecko-nft");
  assert.equal(ranked[1].eligible, false);
  assert.match(ranked[1].reason, /jailed 90s/);
});

test("an exhausted freshness budget is a gate, not a penalty", () => {
  const ranked = scoreSources([lane("opensea-stats"), lane("coingecko-nft")], new Map([["opensea-stats", ev({ budgetExhausted: true })]]));
  assert.equal(ranked[0].lane.source, "coingecko-nft");
  assert.equal(ranked.find((c) => c.lane.source === "opensea-stats")!.eligible, false);
});

test("learned reliability beats matrix order: a flaky first source loses to a reliable second one", () => {
  const ranked = scoreSources(
    [lane("opensea-stats"), lane("coingecko-nft")],
    new Map([
      ["opensea-stats", ev({ calls: 40, ok: 10, avgLatencyMs: 400 })],
      ["coingecko-nft", ev({ calls: 40, ok: 40, avgLatencyMs: 300 })],
    ])
  );
  assert.equal(ranked[0].lane.source, "coingecko-nft");
  assert.ok(ranked[0].terms.reliability > ranked[1].terms.reliability);
});

test("with no evidence at all, cheaper sources rank first and matrix order breaks ties", () => {
  const ranked = scoreSources([lane("opensea-stats"), lane("magiceden-solana"), lane("coingecko-nft")], new Map());
  assert.equal(ranked[0].lane.source, "magiceden-solana", "keyless source costs least");
  assert.ok(ranked.every((c) => c.eligible));
  assert.ok(ranked.every((c) => /no recent evidence/.test(c.reason)));
});

test("budget pressure lowers the score continuously up to -40", () => {
  const [calm] = scoreSources([lane("opensea-stats")], new Map([["opensea-stats", ev({ budgetPressure: 0 })]]));
  const [hot] = scoreSources([lane("opensea-stats")], new Map([["opensea-stats", ev({ budgetPressure: 1 })]]));
  assert.equal(calm.score - hot.score, 40);
});

test("every mesh source maps to a provider budget or explicitly to none, and has a cost", () => {
  for (const s of ["opensea-stats", "unisat-rarity", "helius-membership", "magiceden-solana", "hypersync-discovery", "seaport-fills", "native-robinwood"] as const) {
    assert.ok(costUnitsForSource(s) >= 1);
    providerForSource(s); // must not throw
  }
  assert.equal(providerForSource("opensea-membership"), "opensea");
  assert.equal(providerForSource("native-robinwood"), null);
});

test("lanesFor returns only lanes that may write that cell on that chain", () => {
  const lanes = lanesFor("eth-mainnet", "floor");
  assert.ok(lanes.length >= 2);
  assert.ok(lanes.every((l) => l.chainSlug === "eth-mainnet" && l.cells.includes("floor")));
  assert.deepEqual(lanesFor("not-a-chain", "floor"), []);
});

test("corroborate: agreement is exact, a disagreement is surfaced and never averaged", () => {
  assert.deepEqual(corroborate([{ source: "a", value: 10_000 }, { source: "b", value: 10_000 }]), { status: "agreed", value: 10_000, sources: ["a", "b"] });
  assert.deepEqual(corroborate([{ source: "a", value: 10_000 }, { source: "b", value: null }]), { status: "single", value: 10_000, sources: ["a"] });
  const d = corroborate([{ source: "a", value: 10_000 }, { source: "b", value: 9_999 }]);
  assert.equal(d.status, "disagreed");
  assert.deepEqual(corroborate([{ source: "a", value: null }]), { status: "empty" });
  // Case-only differences in a name are NOT fuzzy-matched into agreement unless the caller says so.
  assert.equal(corroborate([{ source: "a", value: "Milady" }, { source: "b", value: "milady" }]).status, "disagreed");
  assert.equal(corroborate([{ source: "a", value: "Milady" }, { source: "b", value: "milady" }], (v) => v.toLowerCase()).status, "agreed");
});
