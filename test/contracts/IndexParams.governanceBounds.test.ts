import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

import { TIMELOCK, deployOpenIndex } from "./helpers/index-vault";

/**
 * ==========================================================================
 *  GOVERNED-PARAMETER BOUNDS — audit M-3 / M-4.
 *
 *  The audit's framing question was "what is the worst thing a malicious but
 *  perfectly legal governance action can do", and the answer was: switch
 *  whole safety subsystems off, one queueParam at a time, with the timelock
 *  faithfully announcing it and nothing rejecting it.
 *
 *      largeOpValueWei = type(uint256).max   -> nothing is ever "large", so
 *                                              the persistence/confirmation
 *                                              subsystem never runs again
 *      persistenceToleranceBps = 10000       -> every observation is
 *                                              "persistent"; same effect
 *      priceCapBps = 2000 @ interval = 1s    -> 20% per second, 8.9x in 13
 *                                              blocks of a 2s chain
 *      priceCapBps = 1                       -> the oracle freezes at a
 *                                              stale price and every
 *                                              checkpoint still succeeds
 *
 *  Each `it` below queues one of those, waits the FULL timelock, and demands
 *  the execution revert. Every case is paired with an accepted value at the
 *  same key, so no assertion can pass because the key is simply unreachable.
 *  Restore any one bound in `IndexParams.validate` and the matching case
 *  goes red.
 *
 *  LOCAL HARDHAT ONLY.
 * ==========================================================================
 */

const b32 = (s: string) => ethers.encodeBytes32String(s);
const MAX_UINT = (1n << 256n) - 1n;

describe("Governed parameter bounds (audit M-3 / M-4)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  async function tryParam(vault: any, risk: any, name: string, value: bigint) {
    const key = b32(name);
    await vault.connect(risk).queueParam(key, value);
    await time.increase(TIMELOCK + 1);
    return vault.executeParam(key);
  }

  /** Every (key, value) that must be REJECTED at execution, and why. */
  const rejected: { name: string; value: bigint; why: string }[] = [
    // ── M-4 ────────────────────────────────────────────────────────────
    {
      name: "largeOpValueWei",
      value: MAX_UINT,
      why: "permanently disables the persistence/confirmation subsystem",
    },
    {
      name: "largeOpValueWei",
      value: 1n,
      why: "makes every dust operation 'large' — a denial of service on the priced doors",
    },
    {
      name: "persistenceToleranceBps",
      value: 10_000n,
      why: "a 100% tolerance confirms everything, i.e. confirms nothing",
    },
    {
      name: "persistenceToleranceBps",
      value: 1n,
      why: "so tight no honest observation set ever confirms — bricks every large op",
    },
    // ── M-3 ────────────────────────────────────────────────────────────
    {
      name: "minCheckpointInterval",
      value: 1n,
      why: "per-block oracle granularity: the truncated cap compounds per block",
    },
    {
      name: "priceCapBps",
      value: 1n,
      why: "freezes the oracle at a stale price while every checkpoint still succeeds",
    },
    {
      name: "priceCapBps",
      value: 2_000n,
      why: "20% per observation at the 600s default is 120%/hour — over the rate budget",
    },
  ];

  for (const c of rejected) {
    it(`REJECTS ${c.name} = ${c.value} — ${c.why}`, async () => {
      const { vault, risk } = await deployOpenIndex();
      await expect(tryParam(vault, risk, c.name, c.value)).to.be.revertedWithCustomError(
        vault,
        "BadParam"
      );
    });
  }

  /**
   * The anti-vacuity control. If these did not land, every rejection above
   * would be explained by "this key cannot be written at all" rather than by
   * the bound under test.
   */
  const accepted: { name: string; value: bigint }[] = [
    { name: "largeOpValueWei", value: ethers.parseEther("25") },
    { name: "persistenceToleranceBps", value: 800n },
    { name: "priceCapBps", value: 600n },
    { name: "minCheckpointInterval", value: 900n },
  ];

  for (const c of accepted) {
    it(`ACCEPTS ${c.name} = ${c.value} — the bound is a bound, not a wall`, async () => {
      const { vault, risk } = await deployOpenIndex();
      await tryParam(vault, risk, c.name, c.value);
      const p = await vault.params();
      expect(p[c.name as keyof typeof p]).to.equal(c.value);
    });
  }

  /**
   * M-3's real content: the cap is only as strong as the cadence it is
   * applied at, so the two are bounded AS A PAIR. Widening the cap is legal
   * only if the cadence is slowed to match. This is what makes the fix
   * rate-aware rather than per-observation.
   */
  it("M-3 PAIRWISE: a wider price cap is legal ONLY once the checkpoint cadence is slowed to pay for it", async () => {
    const { vault, risk } = await deployOpenIndex();

    // 2000 bps at the 600s default = 12000 bps/hour. Over budget.
    await expect(tryParam(vault, risk, "priceCapBps", 2_000n)).to.be.revertedWithCustomError(
      vault,
      "BadParam"
    );

    // Slow the cadence to 1 hour first...
    await tryParam(vault, risk, "staleAfter", 3n * 3_600n); // staleAfter >= 2*interval
    await tryParam(vault, risk, "minCheckpointInterval", 3_600n);

    // ...and now the same value is legal, because the hourly budget is met.
    await tryParam(vault, risk, "priceCapBps", 2_000n);
    expect((await vault.params()).priceCapBps).to.equal(2_000n);
  });
});
