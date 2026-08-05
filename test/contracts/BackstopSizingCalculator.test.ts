import { expect } from "chai";
import { ethers, artifacts } from "hardhat";

/**
 * Audit-style suite for BackstopSizingCalculator.
 *
 * The contract makes TWO claims and this file is organised around attacking
 * both of them rather than confirming them politely:
 *
 *   1. IT IS STRUCTURALLY INERT. Its header asserts zero storage, zero payable
 *      functions and zero custody. Those are claims about the ARTIFACT and the
 *      deployed ACCOUNT, so they are checked against those and not against the
 *      comment that makes them. A future change that adds a state variable, a
 *      payable function, a receive/fallback, or any non-view entry point breaks
 *      a test in here.
 *   2. ITS CVaR MATH IS RIGHT. Every expectation in the maths block is a
 *      HAND-COMPUTED reference value derived from the index convention stated
 *      in the contract's own NatSpec — never a number read back out of the
 *      contract and frozen. Where the file checks a property instead of a
 *      value (order-blindness, coherence, VaR's blindness to the tail) it
 *      checks the property that property EXISTS FOR.
 *
 * LOCAL HARDHAT ONLY. Nothing in this repo may deploy any of these contracts
 * until the external audit gate (§2.6) clears.
 */
describe("BackstopSizingCalculator", () => {
  const BPS = 10_000n;

  async function deploy() {
    const F = await ethers.getContractFactory("BackstopSizingCalculator");
    const calc: any = await F.deploy();
    return { calc, addr: await calc.getAddress() };
  }

  /**
   * The reference implementation, written straight from the NatSpec index
   * convention and deliberately NOT transcribed from the Solidity. If the two
   * disagree, one of them is wrong and the test says so.
   */
  function referenceCvar(losses: bigint[], confidenceBps: bigint) {
    const s = [...losses].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const n = BigInt(s.length);
    let cut = (n * confidenceBps) / BPS;
    if (cut >= n) cut = n - 1n;
    const tail = s.slice(Number(cut));
    const sum = tail.reduce((a, b) => a + b, 0n);
    return {
      varWei: s[Number(cut)],
      cvarWei: sum / BigInt(tail.length),
      tailCount: BigInt(tail.length),
    };
  }

  // ══ 1. STRUCTURAL INERTNESS ═══════════════════════════════════════════

  describe("STATELESS BY CONSTRUCTION", () => {
    it("the ABI contains no payable, no receive, no fallback and no state-changing function", async () => {
      const art = await artifacts.readArtifact("BackstopSizingCalculator");

      const offenders: string[] = [];
      for (const frag of art.abi as any[]) {
        if (frag.type === "receive" || frag.type === "fallback") {
          offenders.push(`${frag.type}()`);
          continue;
        }
        if (frag.type === "constructor") {
          // A payable constructor is a custody path open for exactly one
          // transaction, which is one more than "cannot hold value".
          if (frag.stateMutability === "payable") offenders.push("constructor payable");
          continue;
        }
        if (frag.type !== "function") continue;
        if (frag.stateMutability !== "view" && frag.stateMutability !== "pure") {
          offenders.push(`${frag.name}: ${frag.stateMutability}`);
        }
      }
      expect(offenders, `non-inert ABI entries: ${offenders.join(", ")}`).to.deep.equal([]);

      // And there IS an ABI, so the assertion above is not vacuously true.
      const fns = (art.abi as any[]).filter((f) => f.type === "function");
      expect(fns.length).to.be.greaterThan(3);
    });

    it("no function name anywhere in the ABI implies custody, transfer or an owner", async () => {
      const art = await artifacts.readArtifact("BackstopSizingCalculator");
      const banned =
        /transfer|approve|withdraw|deposit|owner|admin|sweep|rescue|mint|burn|token|vault|treasury|reserve(?!Wei)/i;
      const hits = (art.abi as any[])
        .filter((f) => f.type === "function" && banned.test(f.name))
        .map((f) => f.name);
      // `suggestedReserveWei` is the one name containing "reserve" and it is a
      // pure calculation returning a number — hence the negative lookahead.
      expect(hits).to.deep.equal([]);
    });

    it("cannot be sent ETH: a bare transfer from an EOA reverts and the balance stays zero", async () => {
      const { addr } = await deploy();
      const [payer] = await ethers.getSigners();
      await expect(payer.sendTransaction({ to: addr, value: ethers.parseEther("1") })).to.be
        .reverted;
      expect(await ethers.provider.getBalance(addr)).to.equal(0n);
    });

    it("cannot be sent ETH with calldata either — there is no payable fallback to catch it", async () => {
      const { addr } = await deploy();
      const [payer] = await ethers.getSigners();
      await expect(payer.sendTransaction({ to: addr, value: 1n, data: "0xdeadbeef" })).to.be
        .reverted;
      expect(await ethers.provider.getBalance(addr)).to.equal(0n);
    });

    it("cannot be sent ETH through one of its OWN selectors — no function is payable", async () => {
      const { calc, addr } = await deploy();
      const [payer] = await ethers.getSigners();
      const data = calc.interface.encodeFunctionData("capabilities", []);
      await expect(payer.sendTransaction({ to: addr, value: 1n, data })).to.be.reverted;
      expect(await ethers.provider.getBalance(addr)).to.equal(0n);
    });

    it("every storage slot stays zero across a full exercise of the whole ABI", async () => {
      const { calc, addr } = await deploy();
      const losses = [5n, 1n, 9n, 3n, 7n];
      // Drive every externally reachable entry point as a real transaction, so
      // any SSTORE that existed would have to land.
      await (await calc.expectedShortfall.send(losses, 8_000n)).wait?.();
      await calc.conditionalValueAtRisk(losses, 8_000n);
      await calc.expectedShortfall(losses, 8_000n);
      await calc.valueAtRisk(losses, 8_000n);
      await calc.suggestedReserveWei(losses, 8_000n, 15_000n);
      await calc.capabilities();
      await calc.CALCULATOR_VERSION();
      await calc.MAX_SAMPLES();

      for (let i = 0; i < 16; i++) {
        expect(await ethers.provider.getStorage(addr, i), `slot ${i}`).to.equal(
          ethers.ZeroHash
        );
      }
    });

    it("capabilities() reports (holdsValue=false, hasStorage=false, isPayable=false), and the artifact agrees", async () => {
      const { calc } = await deploy();
      const [holdsValue, hasStorage, isPayable, version] = await calc.capabilities();
      expect(holdsValue).to.equal(false);
      expect(hasStorage).to.equal(false);
      expect(isPayable).to.equal(false);
      expect(version).to.equal(await calc.CALCULATOR_VERSION());

      // A self-report is only worth something if it is checked. The ABI is the
      // independent witness.
      const art = await artifacts.readArtifact("BackstopSizingCalculator");
      const anyPayable = (art.abi as any[]).some((f) => f.stateMutability === "payable");
      expect(anyPayable).to.equal(isPayable);
    });
  });

  // ══ 2. THE CVaR MATHS, AGAINST HAND-COMPUTED REFERENCES ═══════════════

  describe("CVaR / expected shortfall", () => {
    it("n=10, 90% confidence: the tail is the single worst observation (the case the NatSpec works)", async () => {
      const { calc } = await deploy();
      const losses = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n];
      // cutIndex = floor(10 * 0.90) = 9; tail = {s[9]} = {10}
      const [v, c, t] = await calc.conditionalValueAtRisk(losses, 9_000n);
      expect(v).to.equal(10n);
      expect(c).to.equal(10n);
      expect(t).to.equal(1n);
    });

    it("n=10, 50% confidence: tail = {6,7,8,9,10}, VaR 6, CVaR exactly 8", async () => {
      const { calc } = await deploy();
      const losses = [10n, 9n, 8n, 7n, 6n, 5n, 4n, 3n, 2n, 1n];
      // cutIndex = 5; sum(6..10) = 40; 40/5 = 8.
      const [v, c, t] = await calc.conditionalValueAtRisk(losses, 5_000n);
      expect(v).to.equal(6n);
      expect(c).to.equal(8n);
      expect(t).to.equal(5n);
    });

    it("0% confidence degenerates to VaR = the minimum and CVaR = the mean of everything", async () => {
      const { calc } = await deploy();
      const losses = [4n, 1n, 7n, 2n];
      // cutIndex = 0; tail = all; sum 14 / 4 = 3 (floored).
      const [v, c, t] = await calc.conditionalValueAtRisk(losses, 0n);
      expect(v).to.equal(1n);
      expect(c).to.equal(3n);
      expect(t).to.equal(4n);
    });

    it("n=1: any admissible confidence yields the one observation, with tailCount 1", async () => {
      const { calc } = await deploy();
      for (const conf of [0n, 5_000n, 9_900n, 9_999n]) {
        const [v, c, t] = await calc.conditionalValueAtRisk([42n], conf);
        expect(v).to.equal(42n);
        expect(c).to.equal(42n);
        expect(t).to.equal(1n);
      }
    });

    it("the CVaR division FLOORS, and it under-states by strictly less than one wei", async () => {
      const { calc } = await deploy();
      // tail = {3,4} at n=4, conf 5000 -> cutIndex 2, sum 7, 7/2 = 3.5 -> 3.
      const [, c, t] = await calc.conditionalValueAtRisk([1n, 2n, 3n, 4n], 5_000n);
      expect(t).to.equal(2n);
      expect(c).to.equal(3n);
      expect(c * t).to.be.lessThan(7n);
      expect((c + 1n) * t).to.be.greaterThan(7n);
    });

    it("is ORDER-BLIND: the same multiset in any permutation gives an identical answer", async () => {
      const { calc } = await deploy();
      const base = [11n, 3n, 97n, 42n, 5n, 68n, 1n, 23n, 77n, 30n];
      const [v0, c0, t0] = await calc.conditionalValueAtRisk(base, 8_000n);
      // Deliberately hostile orderings: already-sorted (insertion sort's best
      // case), reverse-sorted (its worst case), and a rotation.
      const sorted = [...base].sort((a, b) => Number(a - b));
      const reversed = [...sorted].reverse();
      const rotated = [...base.slice(4), ...base.slice(0, 4)];
      for (const order of [sorted, reversed, rotated]) {
        const [v, c, t] = await calc.conditionalValueAtRisk(order, 8_000n);
        expect(v).to.equal(v0);
        expect(c).to.equal(c0);
        expect(t).to.equal(t0);
      }
      const ref = referenceCvar(base, 8_000n);
      expect(v0).to.equal(ref.varWei);
      expect(c0).to.equal(ref.cvarWei);
      expect(t0).to.equal(ref.tailCount);
    });

    it("handles duplicates, zeros, and an all-zero sample without disturbing the index convention", async () => {
      const { calc } = await deploy();
      const losses = [0n, 0n, 0n, 0n, 5n, 5n, 5n, 5n, 5n, 5n];
      // cutIndex = floor(10*0.7) = 7; s[7] = 5; tail = {5,5,5}.
      const [v, c, t] = await calc.conditionalValueAtRisk(losses, 7_000n);
      expect(v).to.equal(5n);
      expect(c).to.equal(5n);
      expect(t).to.equal(3n);

      // "We have never had a loss" is a legitimate input and must answer zero
      // rather than revert — it is exactly the case the header warns produces a
      // reserve that has never seen a tail event.
      const [v2, c2, t2] = await calc.conditionalValueAtRisk(new Array(8).fill(0n), 9_000n);
      expect(v2).to.equal(0n);
      expect(c2).to.equal(0n);
      expect(t2).to.equal(1n);
    });

    it("THE REASON CVaR EXISTS: two samples with an IDENTICAL VaR have wildly different CVaR", async () => {
      const { calc } = await deploy();
      // Same first nine observations, different worst observation.
      const mild = [1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 100n, 100n];
      const fat = [1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 100n, 10_000n];
      // cutIndex = floor(10*0.8) = 8 -> VaR = s[8] = 100 for both.
      const [vm, cm] = await calc.conditionalValueAtRisk(mild, 8_000n);
      const [vf, cf] = await calc.conditionalValueAtRisk(fat, 8_000n);
      expect(vm).to.equal(100n);
      expect(vf).to.equal(100n);
      expect(vm).to.equal(vf); // VaR cannot tell these two worlds apart AT ALL
      expect(cm).to.equal(100n); // (100 + 100) / 2
      expect(cf).to.equal(5_050n); // (100 + 10000) / 2
      // A reserve sized to VaR is identical in both and 50x short in the
      // second. That is the whole argument in the contract's header.
      expect(cf).to.be.greaterThan(cm * 50n);
    });

    it("COHERENCE: CVaR is sub-additive over a merged book", async () => {
      const { calc } = await deploy();
      // Two books' per-period losses, and the combined book element-wise (the
      // same periods), which is what sub-additivity is stated over.
      const a = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 900n];
      const b = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 900n, 0n];
      const ab = a.map((x, i) => x + b[i]);
      const conf = 9_000n;
      const [, ca] = await calc.conditionalValueAtRisk(a, conf);
      const [, cb] = await calc.conditionalValueAtRisk(b, conf);
      const [, cab] = await calc.conditionalValueAtRisk(ab, conf);
      expect(cab).to.be.at.most(ca + cb);
      // Splitting the book buys nothing, which is the property VaR lacks.
      const va: bigint = await calc.valueAtRisk(a, conf);
      const vb: bigint = await calc.valueAtRisk(b, conf);
      const vab: bigint = await calc.valueAtRisk(ab, conf);
      expect(vab).to.be.at.most(va + vb);
    });

    it("CVaR is monotone non-decreasing in confidence — a tighter tail is never cheaper", async () => {
      const { calc } = await deploy();
      const losses = Array.from({ length: 20 }, (_, i) => BigInt((i + 1) * (i + 1)));
      let prev = 0n;
      for (const conf of [0n, 2_500n, 5_000n, 7_500n, 9_000n, 9_500n, 9_900n]) {
        const [, c] = await calc.conditionalValueAtRisk(losses, conf);
        expect(c).to.be.at.least(prev);
        prev = c;
      }
    });

    it("CVaR >= VaR always, and tailCount shrinks monotonically as confidence rises", async () => {
      const { calc } = await deploy();
      const losses = Array.from({ length: 32 }, (_, i) => BigInt(i * 7 + 3));
      let prevTail = 33n;
      for (const conf of [0n, 1_000n, 5_000n, 9_000n, 9_700n, 9_999n]) {
        const [v, c, t] = await calc.conditionalValueAtRisk(losses, conf);
        expect(c).to.be.at.least(v);
        expect(t).to.be.at.most(prevTail);
        expect(t).to.be.greaterThan(0n);
        prevTail = t;
      }
    });

    it("matches the independent reference implementation across a randomised sweep", async () => {
      const { calc } = await deploy();
      let seed = 987654321n;
      const rnd = (mod: bigint) => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
        return seed % mod;
      };
      for (let trial = 0; trial < 25; trial++) {
        const n = Number(rnd(40n)) + 1;
        const losses = Array.from({ length: n }, () => rnd(10n ** 20n));
        const conf = rnd(10_000n);
        const [v, c, t] = await calc.conditionalValueAtRisk(losses, conf);
        const ref = referenceCvar(losses, conf);
        expect(v, `trial ${trial} var`).to.equal(ref.varWei);
        expect(c, `trial ${trial} cvar`).to.equal(ref.cvarWei);
        expect(t, `trial ${trial} tail`).to.equal(ref.tailCount);
      }
    });

    it("survives wei-scale magnitudes without overflowing the tail sum", async () => {
      const { calc } = await deploy();
      // 512 samples each near 2^200 — the sum is ~2^209, comfortably inside
      // uint256, and this pins that the accumulator was never narrowed.
      const big = 2n ** 200n;
      const losses = new Array(512).fill(big);
      const [v, c, t] = await calc.conditionalValueAtRisk(losses, 9_900n);
      expect(v).to.equal(big);
      expect(c).to.equal(big);
      expect(t).to.equal(512n - (512n * 9_900n) / BPS);
    });
  });

  // ══ 3. THE CONVENIENCE WRAPPERS ═══════════════════════════════════════

  describe("wrappers", () => {
    it("expectedShortfall and valueAtRisk agree exactly with the tuple form", async () => {
      const { calc } = await deploy();
      const losses = [3n, 17n, 5n, 11n, 2n, 29n, 7n, 13n];
      for (const conf of [0n, 2_500n, 7_500n, 9_999n]) {
        const [v, c] = await calc.conditionalValueAtRisk(losses, conf);
        expect(await calc.expectedShortfall(losses, conf)).to.equal(c);
        expect(await calc.valueAtRisk(losses, conf)).to.equal(v);
      }
    });

    it("suggestedReserveWei rounds UP — a reserve that rounds down is a reserve that is short", async () => {
      const { calc } = await deploy();
      const losses = [1n, 2n, 3n, 4n]; // CVaR at 5000 = 3
      expect(await calc.expectedShortfall(losses, 5_000n)).to.equal(3n);

      // 3 * 1.2345 = 3.7035 -> 4, not 3.
      expect(await calc.suggestedReserveWei(losses, 5_000n, 12_345n)).to.equal(4n);
      // Exact multiples are NOT bumped by the round-up term.
      expect(await calc.suggestedReserveWei(losses, 5_000n, 10_000n)).to.equal(3n);
      expect(await calc.suggestedReserveWei(losses, 5_000n, 20_000n)).to.equal(6n);
      // ceil(0) is 0, not 1.
      expect(await calc.suggestedReserveWei(losses, 5_000n, 0n)).to.equal(0n);
    });

    it("suggestedReserveWei is monotone in coverage and never below the raw CVaR at 1.0x", async () => {
      const { calc } = await deploy();
      const losses = [10n ** 18n, 3n * 10n ** 18n, 7n * 10n ** 18n, 2n * 10n ** 18n];
      const cvar: bigint = await calc.expectedShortfall(losses, 5_000n);
      let prev = 0n;
      for (const cov of [0n, 5_000n, 10_000n, 12_500n, 20_000n, 100_000n]) {
        const r: bigint = await calc.suggestedReserveWei(losses, 5_000n, cov);
        expect(r).to.be.at.least(prev);
        prev = r;
        if (cov >= 10_000n) expect(r).to.be.at.least(cvar);
      }
    });
  });

  // ══ 4. INPUT VALIDATION AND THE ONE DoS SURFACE ═══════════════════════

  describe("guards", () => {
    it("rejects an empty sample rather than dividing by zero", async () => {
      const { calc } = await deploy();
      await expect(calc.conditionalValueAtRisk([], 9_000n)).to.be.revertedWithCustomError(
        calc,
        "NoSamples"
      );
      await expect(calc.expectedShortfall([], 9_000n)).to.be.revertedWithCustomError(
        calc,
        "NoSamples"
      );
      await expect(
        calc.suggestedReserveWei([], 9_000n, 10_000n)
      ).to.be.revertedWithCustomError(calc, "NoSamples");
    });

    it("rejects confidence at or above 100%, where the tail is empty and ES is undefined", async () => {
      const { calc } = await deploy();
      for (const bad of [10_000n, 10_001n, 2n ** 64n]) {
        await expect(
          calc.conditionalValueAtRisk([1n, 2n, 3n], bad)
        ).to.be.revertedWithCustomError(calc, "BadConfidence");
      }
      // 9_999 is the largest admissible value and must work.
      const [, , t] = await calc.conditionalValueAtRisk([1n, 2n, 3n], 9_999n);
      expect(t).to.equal(1n);
    });

    it("MAX_SAMPLES is enforced exactly: 512 is accepted, 513 is refused", async () => {
      const { calc } = await deploy();
      expect(await calc.MAX_SAMPLES()).to.equal(512n);

      const ok = Array.from({ length: 512 }, (_, i) => BigInt(i + 1));
      const [, , t] = await calc.conditionalValueAtRisk(ok, 9_000n);
      expect(t).to.equal(512n - (512n * 9_000n) / BPS);

      const tooMany = Array.from({ length: 513 }, (_, i) => BigInt(i + 1));
      await expect(
        calc.conditionalValueAtRisk(tooMany, 9_000n)
      ).to.be.revertedWithCustomError(calc, "TooManySamples");
    });

    it("the sort's WORST case (512 reverse-sorted samples) still answers correctly", async () => {
      const { calc } = await deploy();
      // Reverse-sorted is the adversarial input against the only DoS surface
      // this contract has, and `losses` is caller-supplied in any order — so
      // an attacker picks this ordering for free.
      const worst = Array.from({ length: 512 }, (_, i) => BigInt(512 - i));
      const [v, c, t] = await calc.conditionalValueAtRisk(worst, 9_000n);
      const ref = referenceCvar(worst, 9_000n);
      expect(v).to.equal(ref.varWei);
      expect(c).to.equal(ref.cvarWei);
      expect(t).to.equal(ref.tailCount);
      // Sanity on the reference itself: cutIndex = 460, tail = s[460..511].
      expect(t).to.equal(52n);
      expect(v).to.equal(461n);
    });

    /**
     * ROUND-4 REGRESSION GUARD, and the test that found the bug.
     *
     * MAX_SAMPLES documents itself as the gas bound on the sort. A bound on the
     * ARRAY LENGTH is not a bound on the WORK if the work is quadratic in it,
     * and it was: the original insertion sort cost 966k gas at n=64, 3.7M at
     * n=128, 14.8M at n=256 and could not complete at all past roughly n=300
     * under a 30M block — so the advertised 512 was unreachable for exactly the
     * ordering an attacker would supply. The sort is now O(n log n) on every
     * input. This test asserts the claim in gas terms rather than in prose, and
     * asserts the thing that actually matters: worst case and best case are
     * within a small constant factor of each other, i.e. there is no longer an
     * ordering worth attacking with.
     */
    it("GAS: the worst ordering at MAX_SAMPLES is affordable, and is not materially worse than the best", async () => {
      const { calc } = await deploy();
      const n = 512;
      const worst = Array.from({ length: n }, (_, i) => BigInt(n - i)); // descending
      const best = Array.from({ length: n }, (_, i) => BigInt(i + 1)); // ascending
      const shuffled = [...best];
      let s = 1234567n;
      for (let i = shuffled.length - 1; i > 0; i--) {
        s = (s * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
        const j = Number(s % BigInt(i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      const gWorst: bigint = await calc.conditionalValueAtRisk.estimateGas(worst, 9_000n);
      const gBest: bigint = await calc.conditionalValueAtRisk.estimateGas(best, 9_000n);
      const gShuf: bigint = await calc.conditionalValueAtRisk.estimateGas(shuffled, 9_000n);

      // Comfortably inside a conservative 30M block, with room for the call to
      // be made from inside another contract rather than at the top level.
      const BUDGET = 10_000_000n;
      expect(gWorst, `worst-case gas ${gWorst}`).to.be.lessThan(BUDGET);
      expect(gShuf).to.be.lessThan(BUDGET);
      expect(gBest).to.be.lessThan(BUDGET);

      // The load-bearing assertion: no input ordering is dramatically more
      // expensive than any other. Under the old quadratic sort this ratio was
      // unbounded (best case stayed near 420k while the worst case exceeded a
      // whole block).
      expect(gWorst * 10n).to.be.lessThan(gBest * 25n);

      // And it still produces the right answer at the bound, in every ordering.
      const ref = referenceCvar(worst, 9_000n);
      for (const order of [worst, best, shuffled]) {
        const [v, c, t] = await calc.conditionalValueAtRisk(order, 9_000n);
        expect(v).to.equal(ref.varWei);
        expect(c).to.equal(ref.cvarWei);
        expect(t).to.equal(ref.tailCount);
      }
    });
  });
});
