import test from "node:test";
import assert from "node:assert/strict";
import { settleCappedPool } from "../../lib/casino/economics-capped-pool";
import { settlementDescriptor, replayCommittedRound } from "../../lib/casino/settlement-rules";
import { effectiveSettlementTarget } from "../../lib/playtest-room-core";

test("capped laboratory targets cannot be changed by a live lock or disabled auto-lock", () => {
  assert.equal(effectiveSettlementTarget(50000n, 20000n, 10100n, false, true), 20000n);
  assert.equal(effectiveSettlementTarget(10000n, 20000n, null, false, true), 20000n);
});

test("capped rule replays its own commitment and rejects a legacy or altered hash", () => {
  const inputs = { playerDistributable: 30000n, seedH: 0n, crashBps: 30000n, reserveAtLock: 0n,
    seats: [{ id: "a", stake: 10000n, targetBps: 10100n }, { id: "b", stake: 10000n, targetBps: 30000n }] };
  const descriptor = settlementDescriptor("capped-survivor-pool");
  const r = replayCommittedRound({ descriptor, inputs });
  assert.deepEqual(r.allocations.map(a => a.payout), [10100n, 19900n]);
  assert.throws(() => replayCommittedRound({ descriptor: { ...descriptor, paramsHash: settlementDescriptor("ccs-2l").paramsHash }, inputs }));
  assert.throws(() => replayCommittedRound({ descriptor: { ...descriptor, version: 2 }, inputs }));
});

test("funding monotonicity, permutation, same-target splitting dust, caps and floors", () => {
  let seed = 20260909n;
  const rand = (n: bigint) => { seed = (seed * 6364136223846793005n + 1n) & ((1n << 64n) - 1n); return seed % n; };
  for (let k = 0; k < 2000; k++) {
    const seats = Array.from({ length: 2 + Number(rand(20n)) }, (_, i) => ({ id: String(i), stake: 10000n + rand(10n ** 22n), targetBps: 10100n + rand(1000000n) }));
    const crash = 10100n + rand(1000000n), d = seats.reduce((a, s) => a + s.stake, 0n) * 9550n / 10000n, h = rand(d + 1n);
    const a = settleCappedPool(d, h, crash, seats), b = settleCappedPool(d, h + d, crash, seats);
    assert.equal(a.totalPayout + a.houseReturned + a.bustedToReserve, d + h);
    const reversed = settleCappedPool(d, h, crash, [...seats].reverse());
    assert.deepEqual(a.allocations.map(x => x.payout), reversed.allocations.map(x => x.payout).reverse());
    for (let i = 0; i < seats.length; i++) {
      assert.ok(b.allocations[i].payout >= a.allocations[i].payout);
      assert.ok(a.allocations[i].payout <= seats[i].stake * seats[i].targetBps / 10000n);
      assert.ok(!a.allocations[i].survived || a.allocations[i].payout >= seats[i].stake * 7500n / 10000n);
    }
    // Divisible stakes avoid floor/cap ambiguity; sharing dust remains bounded.
    const whole = { id: "whole", stake: 100000000n, targetBps: 20000n };
    const others = seats.slice(1);
    const split = Array.from({ length: 10 }, (_, i) => ({ ...whole, id: `split${i}`, stake: whole.stake / 10n }));
    const one = settleCappedPool(d, h, 20000n, [whole, ...others]).allocations[0].payout;
    const many = settleCappedPool(d, h, 20000n, [...split, ...others]).allocations.slice(0, 10).reduce((sum, x) => sum + x.payout, 0n);
    assert.ok(many <= one && one - many < 10n);
  }
});

test("arbitrary mixed-target coalition core EV is bounded by stakes across every crash residue", () => {
  const seats = [10100n, 10200n, 20000n, 100000n, 999999n, 100000000n].map((targetBps, i) => ({ id: String(i), targetBps, stake: 10000n * (10n ** BigInt(i)) }));
  const q = seats.reduce((a, s) => a + s.stake, 0n), d = q * 9550n / 10000n;
  const sums = seats.map(() => 0n);
  for (let residue = 0n; residue < 10000n; residue++) {
    const crash = 100000000n / (10000n - residue);
    const result = settleCappedPool(d, q * 10000n, crash, seats);
    result.allocations.forEach((a, i) => sums[i] += a.payout);
  }
  sums.forEach((sum, i) => assert.ok(sum <= seats[i].stake * 10000n));
  // Applies to core crash only, not separately budgeted lottery winnings;
  // assumes uniformly distributed residues and no post-entropy decisions.
});
