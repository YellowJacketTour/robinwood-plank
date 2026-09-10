import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error browser ESM module
import { readRoundSnapshot, netRoundRake } from "../../public/arcade/chain-snapshot.js";

test("round data remains on one block even if latest advances between RPC calls", async () => {
  const calls: unknown[][] = [];
  const read = (value: unknown) => async (...args: unknown[]) => { calls.push(args); return value; };
  const crash = { currentRoundId: read(7n), rounds: read({phase: 1n}), seatCount: read(2n), stakeOf: read(123n), targetOf: read(20000n) };
  const provider = { getBlock: async (tag: unknown) => ({number: tag === "latest" ? 100 : tag, timestamp: 5000, hash: "same"}) };
  const result = await readRoundSnapshot(provider, crash, "wallet");
  assert.equal(result.roundId, 7n); assert.equal(result.stake, 123n); assert.equal(result.chainNow, 5000);
  for (const args of calls) assert.deepEqual(args.at(-1), {blockTag: 100});
  assert.deepEqual(calls[1], [7n, {blockTag: 100}]);
});
test("a reorganized snapshot is rejected before rendering", async () => {
  const read = async () => 0n;
  const crash = { currentRoundId: read, rounds: read, seatCount: read };
  const provider = { getBlock: async (tag: unknown) => ({number: 100, timestamp: 5000, hash: tag === "latest" ? "old" : "replacement"}) };
  await assert.rejects(readRoundSnapshot(provider, crash), /reorganized/);
});
test("lottery quotes use settlement's exact rake rounding and keeper deduction", () => {
  assert.equal(netRoundRake(1n, 450n, 0n), 1n);
  for (const pool of [0n, 1n, 999n, 10001n, 10n ** 24n]) for (const rake of [250n, 450n]) for (const keeper of [0n, 100n, 1000n]) {
    const distributable = pool * (10000n - rake) / 10000n;
    const gross = pool - distributable;
    assert.equal(netRoundRake(pool, rake, keeper), gross - gross * keeper / 10000n);
  }
});
