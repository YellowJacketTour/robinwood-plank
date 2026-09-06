import assert from "node:assert/strict";
import test from "node:test";
import { fullParityMatrix, parityForChain, parityCell, TRADE_FEATURES, paritySummary } from "../../lib/market/multichain/trading/parity-matrix";
import { CHAIN_MANIFESTS } from "../../lib/market/multichain/chains/manifest";
import { planBidLadder } from "../../lib/market/multichain/trading/bid-ladder";
import { quoteSweep, sweepSanity, scopeListings } from "../../lib/market/multichain/trading/sweep-pricing";

test("parity matrix covers every manifest chain × every feature with named evidence", () => {
  const cells = fullParityMatrix();
  assert.equal(cells.length, CHAIN_MANIFESTS.length * TRADE_FEATURES.length);
  for (const c of cells) assert.ok(c.evidence.length > 10, `${c.chainSlug}/${c.feature} needs evidence`);
});

test("parity: no 'proven' cell exists for a surface that has no real signed write on record", () => {
  // Solana has never had a real write (MAGICEDEN_API_KEY absent); foreign EVM has fork proofs only.
  for (const c of parityForChain("solana-mainnet")) assert.notEqual(c.state, "proven", `${c.feature}`);
  for (const c of parityForChain("base-mainnet")) assert.notEqual(c.state, "proven", `${c.feature}`);
  assert.equal(parityCell("bitcoin-mainnet", "list").state, "proven", "testnet4 proof is on record");
  assert.equal(parityCell("robinhood", "buy").state, "proven");
  assert.equal(parityCell("bitcoin-mainnet", "sweep-floor").state, "gated");
  assert.equal(parityCell("eth-mainnet", "bundle").state, "unavailable");
});

test("paritySummary counts every state", () => {
  const s = paritySummary(fullParityMatrix());
  assert.equal(s.proven + s["built-unproven"] + s.gated + s.unavailable, fullParityMatrix().length);
  assert.ok(s.gated > 0 && s.proven > 0);
});

test("bid ladder: descending rungs, budget respected, leftover swept to the top rung", () => {
  const ladder = planBidLadder({ budgetWei: BigInt(10_000), floorWei: BigInt(1_000), rungs: 3, startPct: 0.9, stepPct: 0.1 });
  assert.equal(ladder.rungs.length, 3);
  assert.deepEqual(ladder.rungs.map((r) => r.priceWei), [BigInt(900), BigInt(800), BigInt(700)]);
  assert.ok(ladder.spentWei <= BigInt(10_000));
  assert.equal(ladder.spentWei + ladder.leftoverWei, BigInt(10_000));
  assert.ok(ladder.leftoverWei < BigInt(900), "leftover smaller than one top-rung item");
});

test("bid ladder: no floor or no budget -> no rungs, never a fabricated price", () => {
  assert.equal(planBidLadder({ budgetWei: BigInt(0), floorWei: BigInt(1000), rungs: 3, startPct: 0.9, stepPct: 0.1 }).rungs.length, 0);
  assert.equal(planBidLadder({ budgetWei: BigInt(1000), floorWei: BigInt(0), rungs: 3, startPct: 0.9, stepPct: 0.1 }).rungs.length, 0);
  const capped = planBidLadder({ budgetWei: BigInt(100_000), floorWei: BigInt(1000), rungs: 2, startPct: 0.5, stepPct: 0.1, maxPerRung: 3 });
  assert.ok(capped.rungs.every((r) => r.quantity <= 3));
});

const book = [
  { tokenId: "1", priceWei: "100", tier: "Common", traits: [{ traitType: "Hat", value: "cap" }] },
  { tokenId: "2", priceWei: "110", tier: "Rare", traits: [{ traitType: "Hat", value: "crown" }] },
  { tokenId: "3", priceWei: "150", tier: "Common", traits: [{ traitType: "Hat", value: "cap" }] },
  { tokenId: "4", priceWei: "900", tier: "Legendary", traits: [{ traitType: "Hat", value: "crown" }] },
  { tokenId: "5", priceWei: "not-a-number", tier: "Common" },
];

test("sweep quote: exact cost off the book, impact vs floor, honest availability", () => {
  const q = quoteSweep(book, { kind: "floor" }, 3);
  assert.equal(q.count, 3);
  assert.equal(q.totalWei, BigInt(360));
  assert.equal(q.floorWei, BigInt(100));
  assert.equal(q.topWei, BigInt(150));
  assert.equal(q.impact, 0.5);
  assert.equal(q.available, 4, "the unparseable listing is excluded, not priced");
  const big = quoteSweep(book, { kind: "floor" }, 10);
  assert.equal(big.count, 4, "book ran out: count < requested");
});

test("sweep scope: tier and trait are filters before pricing", () => {
  assert.deepEqual(scopeListings(book, { kind: "tier", tiers: ["rare", "Legendary"] }).map((l) => l.tokenId), ["2", "4"]);
  assert.deepEqual(scopeListings(book, { kind: "trait", clauses: [{ traitType: "Hat", value: "cap" }] }).map((l) => l.tokenId), ["1", "3"]);
  const q = quoteSweep(book, { kind: "trait", clauses: [{ traitType: "Hat", value: "crown" }] }, 2);
  assert.equal(q.totalWei, BigInt(1010));
});

test("sweep sanity: cap from the real fill median; no fills -> no cap, never a fabricated one", () => {
  const q = quoteSweep(book, { kind: "floor" }, 4);
  const s = sweepSanity(q, [{ priceWei: "100", timestamp: null }, { priceWei: "120", timestamp: null }, { priceWei: "130", timestamp: null }], 0.5);
  assert.equal(s.medianFillWei, BigInt(120));
  assert.equal(s.maxPerItemWei, BigInt(180));
  assert.equal(s.aboveCap, 1, "only the 900 item is above cap");
  const none = sweepSanity(q, []);
  assert.equal(none.maxPerItemWei, null);
});
