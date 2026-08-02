import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeVaultActivityHistory,
  VAULT_TOPIC_SET,
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

/**
 * The trade ticker filters logs by topic0. A topic that is missing from that
 * set is not an error — eth_getLogs simply never asks for it and the decoder
 * drops it — so the failure mode is an activity feed that looks empty. That is
 * exactly what happened when the current pool renamed LiquidityContributed to
 * LiquidityAdded and added an lpBurned argument to LiquidityRemoved: both
 * signatures changed, both hashes changed, and every add/remove on it vanished
 * from the feed while the trade events kept working.
 */
test("every trade and liquidity event of BOTH pool generations is covered", async () => {
  const { Interface } = await import("ethers");
  const legacyAbi = (await import("../../lib/market/vault-abi.json", { with: { type: "json" } })).default;
  const v3Abi = (await import("../../lib/market/vault-v3-abi.json", { with: { type: "json" } })).default;

  const legacy = new Interface(legacyAbi as never);
  const v3 = new Interface(v3Abi as never);

  const required: Array<[string, string]> = [
    ["legacy Bought", legacy.getEvent("Bought")!.topicHash],
    ["legacy Sold", legacy.getEvent("Sold")!.topicHash],
    ["legacy Deposited", legacy.getEvent("Deposited")!.topicHash],
    ["legacy Redeemed", legacy.getEvent("Redeemed")!.topicHash],
    ["legacy LiquidityContributed", legacy.getEvent("LiquidityContributed")!.topicHash],
    ["legacy LiquidityRemoved", legacy.getEvent("LiquidityRemoved")!.topicHash],
    ["v3 Bought", v3.getEvent("Bought")!.topicHash],
    ["v3 Sold", v3.getEvent("Sold")!.topicHash],
    ["v3 Deposited", v3.getEvent("Deposited")!.topicHash],
    ["v3 Redeemed", v3.getEvent("Redeemed")!.topicHash],
    ["v3 LiquidityAdded", v3.getEvent("LiquidityAdded")!.topicHash],
    ["v3 LiquidityRemoved", v3.getEvent("LiquidityRemoved")!.topicHash],
  ];

  for (const [label, hash] of required) {
    assert.ok(
      VAULT_TOPIC_SET.has(hash.toLowerCase()),
      `${label} (${hash}) is not in VAULT_TOPIC_SET — its events would silently never appear`
    );
  }
});

test("the two generations' liquidity events really do hash differently", async () => {
  // Guards the premise of the separate decode branches. If a future ABI change
  // made these identical, those branches become dead code worth deleting — and
  // if someone assumes they are identical without checking, the feed silently
  // empties again, which is the exact bug this pair of tests exists for.
  const { Interface } = await import("ethers");
  const legacy = new Interface(
    (await import("../../lib/market/vault-abi.json", { with: { type: "json" } })).default as never
  );
  const v3 = new Interface(
    (await import("../../lib/market/vault-v3-abi.json", { with: { type: "json" } })).default as never
  );

  assert.notEqual(
    legacy.getEvent("LiquidityRemoved")!.topicHash,
    v3.getEvent("LiquidityRemoved")!.topicHash,
    "same event name, different signature — the hashes must differ or the extra branch is pointless"
  );
  assert.equal(
    legacy.getEvent("Redeemed")!.topicHash,
    v3.getEvent("Redeemed")!.topicHash,
    "Redeemed is unchanged across generations — one entry covers both, do not add a second"
  );
});
