import { expect } from "chai";
import { ethers, network } from "./helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "./helpers/network-helpers.js";
import { deployOpenIndex, maxIn } from "./helpers/index-vault.js";

/**
 * ============================================================================
 *  ROUND 9f — THE DILUTION RE-VEST (WrappedIndexShare)
 *
 *  Primary regression suite for the CRITICAL finding that `deposit` charged
 *  nothing against the N whitelisted reward streams while `withdraw` paid every
 *  stream's pro-rata slice unconditionally, making stream backing extractable
 *  in a single atomic transaction for the price of gas.
 *
 *  The fix gates THE STREAM'S BACKING, not the HOLDER's eligibility. This file
 *  proves both directions of that choice:
 *
 *    - the attack is closed, at every size, including with a flash-sourced
 *      position many times the size of the entire existing pool;
 *    - an honest holder who actually holds across real blocks earns the stream
 *      normally, in full;
 *    - and nothing was locked: wIDX transfers freely, exits never block, and a
 *      per-address holding stamp — which would have been washed by a transfer
 *      and would have stranded every LP behind a pooled holder — was NOT what
 *      was built.
 *
 *  LOCAL HARDHAT ONLY. Same deployment gate as the contract itself.
 * ============================================================================
 */
describe("WrappedIndexShare — dilution re-vest (round 9f)", () => {
  let __snap: SnapshotRestorer;
  before(async () => {
    __snap = await takeSnapshot();
  });
  after(async () => {
    await __snap.restore();
  });

  const E = (n: string) => ethers.parseEther(n);
  const DELAY = 48 * 3600;

  /** STREAM_VEST_BLOCKS on the contract. Read, never assumed. */
  let VEST: bigint;

  async function fixture() {
    const fx = await deployOpenIndex();
    const signers = await ethers.getSigners();
    const lister = signers[9];
    const briber = signers[10];

    const W = await ethers.getContractFactory("WrappedIndexShare");
    const wrapper: any = await W.deploy(
      fx.vaultAddr,
      "Wrapped Global Index",
      "wIDX",
      fx.roleAdmin.address,
      lister.address,
      DELAY
    );
    const wrapperAddr = await wrapper.getAddress();
    for (const who of [fx.alice, fx.bob, fx.carol]) {
      await fx.vault.connect(who).approve(wrapperAddr, ethers.MaxUint256);
      await fx.tokens[0].connect(who).approve(wrapperAddr, ethers.MaxUint256);
    }
    VEST = await wrapper.STREAM_VEST_BLOCKS();
    return { ...fx, wrapper, wrapperAddr, lister, briber };
  }

  async function listAndFund(fx: any, amount: bigint) {
    const T = await ethers.getContractFactory("MockIndexToken");
    const bribe: any = await T.deploy("BRIBE", "BRIBE");
    const addr = await bribe.getAddress();
    await fx.wrapper.connect(fx.lister).queueStream(addr);
    await time.increase(DELAY + 1);
    await fx.wrapper.executeStream(addr);
    await bribe.mint(fx.briber.address, amount);
    await bribe.connect(fx.briber).approve(fx.wrapperAddr, amount);
    await fx.wrapper.connect(fx.briber).depositStream(addr, amount);
    return { bribe, addr };
  }

  async function mineBlocks(n: bigint) {
    await network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
  }

  /** What `wrappedIn` currently redeems for on the stream leg at `addr`. */
  async function streamQuote(fx: any, addr: string, wrappedIn: bigint) {
    const [tokens, amounts] = await fx.wrapper.previewWithdraw(wrappedIn);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].toLowerCase() === addr.toLowerCase()) return amounts[i] as bigint;
    }
    return 0n;
  }

  // ══ 1. THE EXACT ATOMIC EXPLOIT, CLOSED ══════════════════════════════════

  it("the atomic deposit→withdraw round trip captures ~0 instead of ~99% of the bribe", async () => {
    const fx = await fixture();
    await fx.vault.connect(fx.alice).mintProRata(E("3000"), maxIn(3));
    await fx.wrapper.connect(fx.alice).deposit(E("3000"));

    const BRIBE = E("100000");
    const { bribe, addr } = await listAndFund(fx, BRIBE);

    // The whole bribe is genuinely redeemable before the attack — the fix is
    // not "the stream never pays", it is "a zero-duration position never wins".
    const aliceAll = await fx.wrapper.balanceOf(fx.alice.address);
    const aliceBefore = await streamQuote(fx, addr, aliceAll);
    expect(aliceBefore).to.be.gt((BRIBE * 99n) / 100n);

    // Flash-sized position: 100x the entire existing wrapped pool.
    await fx.vault.connect(fx.bob).mintProRata(E("300000"), maxIn(3));
    const A = await ethers.getContractFactory("MockFlashWrapAttacker");
    const atk: any = await A.deploy();
    const atkAddr = await atk.getAddress();
    await fx.vault.connect(fx.bob).approve(atkAddr, ethers.MaxUint256);

    await atk.connect(fx.bob).attack(fx.wrapperAddr, fx.vaultAddr, E("300000"));
    await atk.sweep(addr, fx.bob.address);
    const stolen = await bribe.balanceOf(fx.bob.address);

    // eslint-disable-next-line no-console
    console.log(
      `\n  atomic capture: ${ethers.formatEther(stolen)} of ${ethers.formatEther(BRIBE)} BRIBE` +
        `  (${((Number(stolen) / Number(BRIBE)) * 100).toFixed(4)}%, was 99.00%)`
    );

    expect(stolen).to.be.lt(BRIBE / 100n, "worst case proved in the header is Vst/(4M) = 1%");
    // The attacker holds no wIDX afterwards — the round trip completed. This
    // is a PRICING fix, not a lock: nothing refused to let them in or out.
    expect(await fx.wrapper.balanceOf(atkAddr)).to.equal(0n);
  });

  it("the bound holds across the whole attacker-size sweep, including f near the 1/(2M) worst case", async () => {
    const BRIBE = E("100000");
    const rows: string[] = [];
    let worst = 0n;
    // 120 raw shares against a 3000-share pool is f ~= 1/26 ~= 1/(2M) doubled;
    // the sweep brackets the analytic worst case from both sides.
    for (const size of ["60", "120", "250", "3000", "30000", "300000"]) {
      const fx = await fixture();
      await fx.vault.connect(fx.alice).mintProRata(E("3000"), maxIn(3));
      await fx.wrapper.connect(fx.alice).deposit(E("3000"));
      const { bribe, addr } = await listAndFund(fx, BRIBE);

      await fx.vault.connect(fx.bob).mintProRata(E(size), maxIn(3));
      const A = await ethers.getContractFactory("MockFlashWrapAttacker");
      const atk: any = await A.deploy();
      await fx.vault.connect(fx.bob).approve(await atk.getAddress(), ethers.MaxUint256);
      await atk.connect(fx.bob).attack(fx.wrapperAddr, fx.vaultAddr, E(size));
      await atk.sweep(addr, fx.bob.address);
      const got: bigint = await bribe.balanceOf(fx.bob.address);
      if (got > worst) worst = got;
      rows.push(
        `        raw in ${size.padStart(7)}  ->  captured ${((Number(got) / Number(BRIBE)) * 100)
          .toFixed(4)
          .padStart(8)}%`
      );
    }
    // eslint-disable-next-line no-console
    console.log("\n  atomic capture vs attacker size (bound: 1.00%):\n" + rows.join("\n"));
    expect(worst).to.be.lt(BRIBE / 100n, "no attacker size breaches the Vst/(4M) bound");
  });

  it("salami-slicing many small deposits does not escape the bound either", async () => {
    const fx = await fixture();
    await fx.vault.connect(fx.alice).mintProRata(E("3000"), maxIn(3));
    await fx.wrapper.connect(fx.alice).deposit(E("3000"));
    const BRIBE = E("100000");
    const { bribe, addr } = await listAndFund(fx, BRIBE);

    // 25 successive in-and-out slices, all in consecutive blocks so the vest
    // barely ticks — the fragmenting strategy, driven rather than argued.
    await fx.vault.connect(fx.bob).mintProRata(E("30000"), maxIn(3));
    const A = await ethers.getContractFactory("MockFlashWrapAttacker");
    for (let i = 0; i < 25; i++) {
      const atk: any = await A.deploy();
      await fx.vault.connect(fx.bob).approve(await atk.getAddress(), ethers.MaxUint256);
      await atk.connect(fx.bob).attack(fx.wrapperAddr, fx.vaultAddr, E("200"));
      await atk.sweep(addr, fx.bob.address);
      await atk.sweep(fx.vaultAddr, fx.bob.address);
    }
    const got: bigint = await bribe.balanceOf(fx.bob.address);
    // eslint-disable-next-line no-console
    console.log(
      `\n  25 salami slices captured ${((Number(got) / Number(BRIBE)) * 100).toFixed(4)}%` +
        `  (analytic limit over an INFINITE sequence is 1/M = 4%)`
    );
    expect(got).to.be.lt((BRIBE * 4n) / 100n, "the 1/M salami limit holds");
  });

  // ══ 2. THE HONEST HOLDER IS NOT DEGRADED ═════════════════════════════════

  it("an honest holder who holds across the vest window earns the stream in FULL", async () => {
    const fx = await fixture();
    await fx.vault.connect(fx.alice).mintProRata(E("3000"), maxIn(3));
    await fx.wrapper.connect(fx.alice).deposit(E("3000"));
    const BRIBE = E("10000");
    const { bribe, addr } = await listAndFund(fx, BRIBE);

    // A second honest holder joins, which displaces a slice into the re-vest.
    await fx.vault.connect(fx.bob).mintProRata(E("3000"), maxIn(3));
    await fx.wrapper.connect(fx.bob).deposit(E("3000"));
    expect(await fx.wrapper.unvestedOf(addr)).to.be.gt(0n);

    // Both of them simply WAIT — no staking, no claim, no call by anybody.
    await mineBlocks(VEST + 1n);
    expect(await fx.wrapper.unvestedOf(addr)).to.equal(0n, "release is automatic and complete");
    expect(await fx.wrapper.streamHeld(addr)).to.equal(BRIBE, "every unit is back in backing");

    // And they split it pro rata, with nothing withheld and nothing lost.
    await fx.wrapper.connect(fx.alice).withdraw(await fx.wrapper.balanceOf(fx.alice.address));
    await fx.wrapper.connect(fx.bob).withdraw(await fx.wrapper.balanceOf(fx.bob.address));
    const paid = (await bribe.balanceOf(fx.alice.address)) + (await bribe.balanceOf(fx.bob.address));
    // eslint-disable-next-line no-console
    console.log(
      `\n  honest holders recovered ${ethers.formatEther(paid)} of ${ethers.formatEther(BRIBE)}` +
        ` after waiting ${VEST} blocks`
    );
    expect(paid).to.be.gt((BRIBE * 999n) / 1000n, "no meaningful degradation of the honest case");
  });

  it("release is strictly monotone in block height and reaches exactly zero on schedule", async () => {
    const fx = await fixture();
    await fx.vault.connect(fx.alice).mintProRata(E("3000"), maxIn(3));
    await fx.wrapper.connect(fx.alice).deposit(E("3000"));
    const { addr } = await listAndFund(fx, E("10000"));

    await fx.vault.connect(fx.bob).mintProRata(E("3000"), maxIn(3));
    await fx.wrapper.connect(fx.bob).deposit(E("3000"));

    const endsAt: bigint = await fx.wrapper.streamVestEndsAt(addr);
    let prev: bigint = await fx.wrapper.unvestedOf(addr);
    expect(prev).to.be.gt(0n);
    for (let i = 0; i < 5; i++) {
      await mineBlocks(VEST / 6n);
      const now: bigint = await fx.wrapper.unvestedOf(addr);
      expect(now).to.be.lt(prev, "displaced backing only ever shrinks with time");
      prev = now;
    }
    await mineBlocks(VEST);
    expect(await fx.wrapper.unvestedOf(addr)).to.equal(0n);
    expect(BigInt(await ethers.provider.getBlockNumber())).to.be.gte(endsAt);
  });

  // ══ 3. IT IS NOT A LOCK, AND IT CANNOT TRAP ══════════════════════════════

  it("wIDX still transfers freely mid-vest, and the recipient's exit is not gated by anything", async () => {
    const fx = await fixture();
    await fx.vault.connect(fx.alice).mintProRata(E("3000"), maxIn(3));
    await fx.wrapper.connect(fx.alice).deposit(E("3000"));
    const { addr } = await listAndFund(fx, E("10000"));
    await fx.vault.connect(fx.bob).mintProRata(E("3000"), maxIn(3));
    await fx.wrapper.connect(fx.bob).deposit(E("3000"));
    expect(await fx.wrapper.unvestedOf(addr)).to.be.gt(0n);

    // A transfer is not an event this contract has any opinion about: there is
    // no per-holder stamp to wash and none to inherit. Carol has never touched
    // the wrapper and exits immediately.
    const half = (await fx.wrapper.balanceOf(fx.bob.address)) / 2n;
    await expect(fx.wrapper.connect(fx.bob).transfer(fx.carol.address, half)).to.not.be.reverted;
    await expect(fx.wrapper.connect(fx.carol).withdraw(half)).to.not.be.reverted;
    // Carol got the raw leg in full — the fix never blocks an exit.
    expect(await fx.vault.balanceOf(fx.carol.address)).to.be.gt(0n);
  });

  it("no role can read, write, extend or reach the vest — there is no setter at all", async () => {
    const fx = await fixture();
    const abi: any[] = (fx.wrapper.interface as any).fragments.filter(
      (f: any) => f.type === "function"
    );
    const writers = abi.filter((f: any) => f.stateMutability !== "view" && f.stateMutability !== "pure");
    const names = writers.map((f: any) => f.name);
    // eslint-disable-next-line no-console
    console.log("\n  mutating surface:", names.join(", "));
    for (const n of names) {
      // `harvest` is not a vest function — match the vest words themselves.
      expect(n.toLowerCase()).to.not.match(
        /(^|[^a-z])(un)?vest|revest|setvest|vestblocks/,
        `"${n}" would be a lever over when users redeem`
      );
    }
    // The window itself is a compile-time constant, not storage.
    expect(await fx.wrapper.STREAM_VEST_BLOCKS()).to.be.gt(0n);
  });

  it("pruneStream refuses to orphan a still-vesting balance, and allows the prune once it releases", async () => {
    const fx = await fixture();
    await fx.vault.connect(fx.alice).mintProRata(E("3000"), maxIn(3));
    await fx.wrapper.connect(fx.alice).deposit(E("3000"));
    const { bribe, addr } = await listAndFund(fx, E("10000"));

    await fx.vault.connect(fx.bob).mintProRata(E("300000"), maxIn(3));
    await fx.wrapper.connect(fx.bob).deposit(E("300000")); // displaces the lot
    expect(await fx.wrapper.streamHeld(addr)).to.equal(0n, "probes as empty...");
    expect(await fx.wrapper.unvestedOf(addr)).to.be.gt(0n, "...but is NOT empty");

    await fx.wrapper.connect(fx.lister).delistStream(addr);
    await expect(fx.wrapper.pruneStream(addr)).to.be.revertedWithCustomError(
      fx.wrapper,
      "StreamNotEmpty"
    );

    // Once released, everyone drains it and the slot frees normally.
    await mineBlocks(VEST + 1n);
    expect(await fx.wrapper.streamHeld(addr)).to.be.gt(0n);
    await fx.wrapper.connect(fx.alice).withdraw(await fx.wrapper.balanceOf(fx.alice.address));
    await fx.wrapper.connect(fx.bob).withdraw(await fx.wrapper.balanceOf(fx.bob.address));
    expect(await bribe.balanceOf(fx.wrapperAddr)).to.be.lt(E("0.001"));
  });

  it("a hostile stream cannot brick `deposit` through the new re-vest path", async () => {
    const fx = await fixture();
    await fx.vault.connect(fx.alice).mintProRata(E("3000"), maxIn(3));
    await fx.wrapper.connect(fx.alice).deposit(E("3000"));

    const H = await ethers.getContractFactory("MockHostileStream");
    const hostile: any = await H.deploy("EVIL", "EVIL");
    const hAddr = await hostile.getAddress();
    await fx.wrapper.connect(fx.lister).queueStream(hAddr);
    await time.increase(DELAY + 1);
    await fx.wrapper.executeStream(hAddr);
    await hostile.mint(fx.briber.address, E("200"));
    await hostile.connect(fx.briber).approve(fx.wrapperAddr, ethers.MaxUint256);
    await fx.wrapper.connect(fx.briber).depositStream(hAddr, E("200"));

    // Every hostile mode at once, including unbounded gas burn in balanceOf.
    await hostile.setModes(true, true, true, true);

    // `deposit` now reads streams, but only through the same bounded-gas
    // STATICCALL `withdraw` already used. It must still work.
    await fx.vault.connect(fx.bob).mintProRata(E("1000"), maxIn(3));
    await expect(fx.wrapper.connect(fx.bob).deposit(E("1000"))).to.not.be.reverted;
    await expect(
      fx.wrapper.connect(fx.bob).withdraw(await fx.wrapper.balanceOf(fx.bob.address))
    ).to.not.be.reverted;
  });

  it("solvency invariant: total claims never exceed real backing across 60 mixed ops", async () => {
    const fx = await fixture();
    for (const who of [fx.alice, fx.bob, fx.carol]) {
      await fx.vault.connect(who).mintProRata(E("20000"), maxIn(3));
    }
    await fx.wrapper.connect(fx.alice).deposit(E("2000"));
    const { bribe, addr } = await listAndFund(fx, E("5000"));

    let seed = 424243n;
    const rnd = (n: number) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      return Number(seed % BigInt(n));
    };
    const actors = [fx.alice, fx.bob, fx.carol];

    for (let i = 0; i < 60; i++) {
      const who = actors[rnd(3)];
      const op = rnd(4);
      try {
        if (op === 0) await fx.wrapper.connect(who).deposit(E(String(1 + rnd(2000))));
        else if (op === 1) {
          const bal = await fx.wrapper.balanceOf(who.address);
          if (bal > 0n) await fx.wrapper.connect(who).withdraw(bal / BigInt(1 + rnd(3)));
        } else if (op === 2) {
          await bribe.mint(fx.briber.address, E("100"));
          await bribe.connect(fx.briber).approve(fx.wrapperAddr, ethers.MaxUint256);
          await fx.wrapper.connect(fx.briber).depositStream(addr, E("100"));
        } else await mineBlocks(BigInt(1 + rnd(400)));
      } catch {
        /* a reverted op is a no-op; the invariant is about the ones that land */
      }

      // THE INVARIANT: what every holder could redeem, together, never exceeds
      // what the wrapper actually holds. The re-vest may only ever make this
      // MORE conservative, never less.
      const supply: bigint = await fx.wrapper.totalSupply();
      if (supply === 0n) continue;
      const [toks, amts] = await fx.wrapper.previewWithdraw(supply);
      for (let j = 0; j < toks.length; j++) {
        const real: bigint = await (await ethers.getContractAt("MockIndexToken", toks[j])).balanceOf(
          fx.wrapperAddr
        );
        expect(amts[j]).to.be.lte(real, `over-claim on leg ${j} at step ${i}`);
      }
    }
  });
});
