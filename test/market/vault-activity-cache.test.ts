import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeVaultActivityHistory,
  type VaultTradeEvent,
} from "../../lib/market/vault-activity";

function event(
  blockNumber: number,
  txHash: string,
  logIndex = 0,
): VaultTradeEvent {
  return {
    kind: "deposit",
    address: "0x1111111111111111111111111111111111111111",
    ethWei: null,
    sharesWei: null,
    tokenId: String(blockNumber),
    txHash,
    blockNumber,
    logIndex,
    timestamp: null,
    vaultAddress: "0x2222222222222222222222222222222222222222",
  };
}

test("a short live scan adds to rather than truncates durable full history", () => {
  const durable = Array.from({ length: 117 }, (_, index) =>
    event(1_000 - index, `0x${(index + 1).toString(16).padStart(64, "0")}`)
  );
  const newest = event(1_001, `0x${"f".repeat(64)}`);

  const merged = mergeVaultActivityHistory(durable, [newest]);

  assert.equal(merged.length, 118);
  assert.equal(merged[0].blockNumber, 1_001);
  assert.equal(merged.at(-1)?.blockNumber, 884);
});

test("durable history merge deduplicates the same vault event", () => {
  const original = event(900, `0x${"a".repeat(64)}`, 7);
  const duplicate = { ...original };

  const merged = mergeVaultActivityHistory([original], [duplicate]);

  assert.deepEqual(merged, [duplicate]);
});
