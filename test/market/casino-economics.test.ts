import assert from "node:assert/strict";
import test from "node:test";
import {
  crashToWinningTick,
  roundEconomics,
  ratifiedRakeSplit,
  sealLotteryEpoch,
  minimumFreshForLotteryGrowth,
  settleParimutuel,
  targetToTick,
  tickCount,
  type AllocationRule,
  type Seat,
} from "../../lib/casino/economics.ts";
import { Fenwick } from "../../lib/casino/fenwick.ts";

test("PFSS returns survivor base before allocating risk surplus", () => {
  const seats: Seat[] = [
    { id: "safe", stake: 100n, targetBps: 15_000n },
    { id: "hunt", stake: 100n, targetBps: 40_000n },
    { id: "bust", stake: 100n, targetBps: 80_000n },
  ];
  const result = settleParimutuel("pfss", 330n, 50_000n, seats);
  assert.equal(result.basePool, 200n);
  assert.equal(result.surplusPool, 130n);
  assert.equal(result.allocations[0].base, 100n);
  assert.equal(result.allocations[1].base, 100n);
  assert.ok(result.allocations[1].surplus > result.allocations[0].surplus);
  assert.equal(result.allocations[2].payout, 0n);
  assert.ok(result.totalPayout <= result.distributable);
  assert.equal(result.totalPayout + result.vaultRemainder, result.distributable);
});

test("PFSS honestly haircuts every survivor when distributable cannot cover survivor stake", () => {
  const result = settleParimutuel("pfss", 180n, 20_000n, [
    { id: "a", stake: 100n, targetBps: 15_000n },
    { id: "b", stake: 100n, targetBps: 15_000n },
  ]);
  assert.equal(result.basePool, 180n);
  assert.equal(result.surplusPool, 0n);
  assert.deepEqual(result.allocations.map((allocation) => allocation.payout), [90n, 90n]);
  assert.deepEqual(result.allocations.map((allocation) => allocation.net), [-10n, -10n]);
});

test("all-bust is objective and leaves the entire distributable for the Vault", () => {
  const result = settleParimutuel("pfss", 777n, 12_000n, [
    { id: "a", stake: 100n, targetBps: 15_000n },
    { id: "b", stake: 200n, targetBps: 25_000n },
  ]);
  assert.equal(result.allBust, true);
  assert.equal(result.totalPayout, 0n);
  assert.equal(result.vaultRemainder, 777n);
});

test("current stake-multiplier rule can create a survived net loss that PFSS prevents when D covers survivors", () => {
  const seats: Seat[] = [
    { id: "safe", stake: 100n, targetBps: 11_000n },
    { id: "hunter", stake: 900n, targetBps: 90_000n },
    { id: "loser", stake: 100n, targetBps: 100_000n },
  ];
  const current = settleParimutuel("stake-multiplier", 1_100n, 95_000n, seats);
  const pfss = settleParimutuel("pfss", 1_100n, 95_000n, seats);
  assert.equal(current.allocations[0].survived, true);
  assert.ok(current.allocations[0].net < 0n);
  assert.ok(pfss.allocations[0].net >= 0n);
});

test("round accounting uses one exact gross, rake, and distributable identity", () => {
  const round = roundEconomics(125n, [100n, 200n, 300n], 450n);
  assert.equal(round.gross, 725n);
  assert.equal(round.rake + round.distributable, round.gross);
  assert.equal(round.distributable, 125n + (600n * 9_550n) / 10_000n);
});

test("ratified rake split remains 0.9/1.8/1.8 percent of fresh wagers", () => {
  const wagers = 100n * 10n ** 18n;
  const rake = (wagers * 450n) / 10_000n;
  const split = ratifiedRakeSplit(rake);
  assert.equal(split.burn, 9n * 10n ** 17n);
  assert.equal(split.community, 18n * 10n ** 17n);
  assert.equal(split.founders, 18n * 10n ** 17n);
  assert.equal(split.keeper + split.burn + split.community + split.founders, rake);
});

test("recurring lottery founder fee still permits an exactly financed monotonic rollover", () => {
  const prior = 100n * 10n ** 18n;
  const increase = 1n * 10n ** 18n;
  const feeBps = 500n;
  const fresh = minimumFreshForLotteryGrowth(prior, 0n, increase, 0n, feeBps);
  const sealed = sealLotteryEpoch(prior, fresh, 0n, feeBps);
  assert.ok(sealed.netPrize >= prior + increase);
  const underfunded = sealLotteryEpoch(prior, fresh - 1n, 0n, feeBps);
  assert.ok(underfunded.netPrize < prior + increase);
  assert.equal(sealed.founderFee + sealed.netPrize, sealed.gross);
});

test("1.01x through 100x has 989,901 one-basis-point ticks, not 9,900", () => {
  assert.equal(tickCount(10_100n, 1_000_000n, 1n), 989_901n);
  assert.equal(tickCount(10_100n, 1_000_000n, 100n), 9_900n);
});

test("raw crash-to-tick mapping preserves target <= crash at every grid edge", () => {
  const min = 10_100n;
  const step = 100n;
  for (let crash = 9_999n; crash <= 20_001n; crash += 1n) {
    const winningTick = crashToWinningTick(crash, min, step);
    for (let target = min; target <= 20_000n; target += step) {
      const tick = targetToTick(target, min, step);
      assert.equal(tick <= winningTick, target <= crash, `crash=${crash} target=${target}`);
    }
  }
});

test("Fenwick prefix exactly matches naive survivor aggregates through replacements", () => {
  const size = 256;
  const tree = new Fenwick(size);
  const buckets = Array<bigint>(size).fill(0n);
  let state = 0x20260827;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let operation = 0; operation < 2_000; operation += 1) {
    const index = random() % size;
    const canRemove = buckets[index] > 0n && random() % 3 === 0;
    const delta = canRemove ? -1n : BigInt((random() % 10) + 1);
    tree.add(index, delta);
    buckets[index] += delta;
    const query = random() % size;
    const expected = buckets.slice(0, query + 1).reduce((sum, value) => sum + value, 0n);
    assert.equal(tree.prefix(query), expected);
  }
});

test("every allocation rule conserves distributable across deterministic fuzz", () => {
  const rules: AllocationRule[] = ["stake-multiplier", "stake-only", "pfss"];
  let state = 0x6d2b79f5;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return (state ^ (state >>> 14)) >>> 0;
  };
  for (let round = 0; round < 1_000; round += 1) {
    const count = 1 + (random() % 25);
    const seats: Seat[] = Array.from({ length: count }, (_, index) => ({
      id: `r${round}-p${index}`,
      stake: BigInt(1 + (random() % 1_000_000)),
      targetBps: BigInt(10_100 + (random() % 989_901)),
    }));
    const distributable = BigInt(random() % 25_000_000);
    const crashBps = BigInt(10_000 + (random() % 1_000_001));
    for (const rule of rules) {
      const result = settleParimutuel(rule, distributable, crashBps, seats);
      assert.ok(result.totalPayout <= distributable);
      assert.equal(result.totalPayout + result.vaultRemainder, distributable);
      for (const allocation of result.allocations) {
        assert.ok(allocation.payout >= 0n);
        if (!allocation.survived) assert.equal(allocation.payout, 0n);
      }
    }
  }
});
