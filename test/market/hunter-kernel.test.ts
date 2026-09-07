import assert from "node:assert/strict";
import test from "node:test";
import { initialChunk, onChunkSuccess, onChunkTooLarge, isRangeTooLargeError, suggestedRangeFromError } from "../../lib/market/multichain/hunter/chunk";
import { isNoop } from "../../lib/market/multichain/hunter/receipt";
import { mayOverwrite } from "../../lib/market/multichain/cell-provenance";
import { admissible } from "../../lib/market/multichain/hunter/sink";
import { familyForChain } from "../../lib/market/multichain/hunter/engine";
import type { HunterReceipt } from "../../lib/market/multichain/hunter/types";

test("adaptive chunk: grows 1.5x on success, halves on too-large, honours vendor hints, never leaves [min,max]", () => {
  let s = initialChunk(10, 5_000, 200);
  s = onChunkSuccess(s, 100);
  assert.equal(s.size, 300);
  s = onChunkSuccess(s, 9_000);
  assert.equal(s.size, 300, "a huge page holds instead of growing");
  s = onChunkTooLarge(s);
  assert.equal(s.size, 150);
  for (let i = 0; i < 20; i += 1) s = onChunkTooLarge(s);
  assert.equal(s.size, 10);
  for (let i = 0; i < 40; i += 1) s = onChunkSuccess(s, 1);
  assert.equal(s.size, 5_000);
  assert.equal(isRangeTooLargeError("query returned more than 10000 results"), true);
  assert.equal(isRangeTooLargeError("Log response size exceeded"), true);
  assert.equal(isRangeTooLargeError("invalid argument 0: json: cannot unmarshal"), false);
  assert.equal(suggestedRangeFromError("You can make eth_getLogs requests with up to a 10 block range"), 10);
  assert.equal(suggestedRangeFromError("nope"), null);
});

test("receipt: no cursor movement + no rows + no findings = noop; anything else is work", () => {
  const base: HunterReceipt = { family: "evm", chainSlug: "base-mainnet", startedAt: "", finishedAt: "", sourceCalls: 1, sourceStatus: "ok", cursorBefore: { kind: "block", block: 5 }, cursorAfter: { kind: "block", block: 5 }, findings: 0, rowsWritten: 0 };
  assert.equal(isNoop(base), true);
  assert.equal(isNoop({ ...base, cursorAfter: { kind: "block", block: 6 } }), false);
  assert.equal(isNoop({ ...base, rowsWritten: 1 }), false);
});

test("cell provenance: higher or equal rank overwrites; lower rank only after the holder's TTL", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  const fresh = { value: "1", source: "hunter-solana" as const, observedAt: "2026-09-07T11:59:00Z" };
  assert.equal(mayOverwrite(null, { source: "coingecko", observedAt: "x" }, now), true);
  assert.equal(mayOverwrite(fresh, { source: "own-book", observedAt: "x" }, now), true);
  assert.equal(mayOverwrite(fresh, { source: "hunter-evm", observedAt: "x" }, now), true, "equal rank may overwrite");
  assert.equal(mayOverwrite(fresh, { source: "opensea-stats", observedAt: "x" }, now), false, "REST vendor cannot clobber a fresh chain-derived floor");
  const stale = { ...fresh, observedAt: "2026-09-07T11:00:00Z" };
  assert.equal(mayOverwrite(stale, { source: "opensea-stats", observedAt: "x" }, now), true, "after the 30-minute TTL a lower rank may refresh it");
});

test("admission law: breadth in one chunk, never a one-token airdrop", () => {
  assert.equal(admissible(500, 1), false);
  assert.equal(admissible(24, 24), false);
  assert.equal(admissible(25, 25), true);
  assert.equal(familyForChain("solana-mainnet"), "solana");
  assert.equal(familyForChain("bitcoin-mainnet"), "bitcoin");
  assert.equal(familyForChain("robinhood"), "evm");
});
