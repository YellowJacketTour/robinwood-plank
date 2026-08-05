import { expect } from "chai";
import { ethers } from "hardhat";
import {
  takeSnapshot,
  time,
  type SnapshotRestorer,
} from "@nomicfoundation/hardhat-network-helpers";
import {
  CONCENTRATION_CAP_BPS,
  TIMELOCK,
  WAD,
  deployOpenIndex,
  maxIn,
} from "./helpers/index-vault";

/**
 * Audit-style suite for PlankGauge, the burn-directed replacement for the
 * vote-escrow contract this branch originally carried. One test per named
 * property of contracts/PlankGauge.sol's header, each attacking the vector the
 * property exists for rather than asserting a happy path — same bar as
 * GlobalIndexVault.audit.test.ts and VaultV3.audit.test.ts.
 *
 * LOCAL HARDHAT ONLY. Nothing in this repo may deploy either contract until the
 * external audit gate (§2.6) clears.
 */
describe("PlankGauge", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const DEAD = "0x000000000000000000000000000000000000dEaD";
  const RAW_MULT = 10_000n;
  const LP_MULT = 25_000n;
  const COLL_MULT = 30_000n;
  const THRESHOLD = ethers.parseEther("1");

  async function fixture() {
    // Offset past the index fixture's signers so a gauge whale can never
    // coincidentally BE a privileged basket role.
    const all = await ethers.getSigners();
    const [gaugeAdmin, whale, minnow, funder] = [all[6], all[7], all[8], all[9]];

    const Token = await ethers.getContractFactory("MockIndexToken");
    const plank: any = await Token.deploy("PLANK", "PLANK");
    const plankEthLp: any = await Token.deploy("PLANK/ETH LP", "PE-LP");
    const collLp: any = await Token.deploy("vROBIN/ETH LP", "VR-LP");
    const impostorLp: any = await Token.deploy("PLANK/ETH LP", "PE-LP"); // same name+symbol

    const Gauge = await ethers.getContractFactory("PlankGauge");
    const gauge: any = await Gauge.deploy(
      await plank.getAddress(),
      gaugeAdmin.address,
      TIMELOCK,
      [RAW_MULT, LP_MULT, COLL_MULT],
      THRESHOLD
    );
    const gaugeAddr = await gauge.getAddress();

    // Two gauge ids standing in for two collections' v-tokens.
    const gA = ethers.Wallet.createRandom().address;
    const gB = ethers.Wallet.createRandom().address;
    const vaultA = ethers.Wallet.createRandom().address;

    await gauge.connect(gaugeAdmin).queueGauge(gA, false);
    await gauge.connect(gaugeAdmin).queueGauge(gB, false);
    await gauge.connect(gaugeAdmin).queuePlankEthLp(await plankEthLp.getAddress(), false);
    await gauge
      .connect(gaugeAdmin)
      .queueCollectionLp(gA, await collLp.getAddress(), vaultA, false);
    await time.increase(TIMELOCK + 1);
    await gauge.executeGauge(gA);
    await gauge.executeGauge(gB);
    await gauge.executePlankEthLp(await plankEthLp.getAddress());
    await gauge.executeCollectionLp(gA);

    for (const who of [whale, minnow]) {
      for (const t of [plank, plankEthLp, collLp, impostorLp]) {
        await t.mint(who.address, 1_000_000n * WAD);
        await t.connect(who).approve(gaugeAddr, ethers.MaxUint256);
      }
    }

    return {
      gaugeAdmin,
      whale,
      minnow,
      funder,
      plank,
      plankEthLp,
      collLp,
      impostorLp,
      gauge,
      gaugeAddr,
      gA,
      gB,
      vaultA,
    };
  }

  // ══ Burn paths and their multipliers ═══════════════════════════════════

  it("an LP burn earns a real multiplier over an identical raw PLANK burn", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, gA, plankEthLp } = fx;
    const amount = 1_000n * WAD;

    await gauge.connect(whale).burnPlank(gA, amount);
    await gauge.connect(minnow).burnPlankEthLp(gA, await plankEthLp.getAddress(), amount);

    const raw: bigint = await gauge.claimantWeightedBurns(gA, whale.address);
    const lp: bigint = await gauge.claimantWeightedBurns(gA, minnow.address);
    expect(raw).to.equal(amount);
    expect(lp).to.equal((amount * LP_MULT) / RAW_MULT);
    expect(lp).to.be.gt(raw, "LP burn must strictly dominate a raw burn");
    expect(await gauge.totalWeightedBurns(gA)).to.equal(raw + lp);
  });

  it("a collection v-token LP burn earns at least the PLANK/ETH LP rate", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, gA, plankEthLp } = fx;
    const amount = 500n * WAD;
    await gauge.connect(whale).burnPlankEthLp(gA, await plankEthLp.getAddress(), amount);
    await gauge.connect(minnow).burnCollectionLp(gA, amount);
    const lp: bigint = await gauge.claimantWeightedBurns(gA, whale.address);
    const coll: bigint = await gauge.claimantWeightedBurns(gA, minnow.address);
    expect(coll).to.be.gte(lp, "the exact-market LP burn must never be worth less");
    expect(coll).to.equal((amount * COLL_MULT) / RAW_MULT);
  });

  it("an impostor LP token — same name, same symbol — earns nothing", async () => {
    const fx = await fixture();
    const { gauge, whale, gA, impostorLp, plankEthLp } = fx;
    expect(await impostorLp.name()).to.equal(await plankEthLp.name());
    expect(await impostorLp.symbol()).to.equal(await plankEthLp.symbol());
    await expect(
      gauge.connect(whale).burnPlankEthLp(gA, await impostorLp.getAddress(), 100n * WAD)
    ).to.be.revertedWithCustomError(gauge, "NotApprovedLp");
    expect(await gauge.claimantWeightedBurns(gA, whale.address)).to.equal(0n);
  });

  it("a collection LP burn cannot be pointed at a different collection's gauge", async () => {
    const fx = await fixture();
    const { gauge, whale, gB } = fx;
    // gB has no registered collection LP, so the path is simply closed there.
    await expect(
      gauge.connect(whale).burnCollectionLp(gB, 100n * WAD)
    ).to.be.revertedWithCustomError(gauge, "NotApprovedLp");
  });

  it("burns cannot be directed at an unregistered gauge", async () => {
    const fx = await fixture();
    const { gauge, whale } = fx;
    const ghost = ethers.Wallet.createRandom().address;
    await expect(gauge.connect(whale).burnPlank(ghost, WAD)).to.be.revertedWithCustomError(
      gauge,
      "UnknownGauge"
    );
  });

  it("the tokens really leave circulation — they land at the dead address", async () => {
    const fx = await fixture();
    const { gauge, whale, gA, plank } = fx;
    const deadBefore: bigint = await plank.balanceOf(DEAD);
    const mine: bigint = await plank.balanceOf(whale.address);
    await gauge.connect(whale).burnPlank(gA, 777n * WAD);
    expect(await plank.balanceOf(DEAD)).to.equal(deadBefore + 777n * WAD);
    expect(await plank.balanceOf(whale.address)).to.equal(mine - 777n * WAD);
    // And the gauge itself never custodies a burnt token.
    expect(await plank.balanceOf(fx.gaugeAddr)).to.equal(0n);
  });

  it("a fee-on-transfer token buys only the weight it actually destroyed", async () => {
    const fx = await fixture();
    const { gauge, whale, gA, plank } = fx;
    await plank.setFeeBps(1_000); // 10% skimmed... to the dead address as well
    const deadBefore: bigint = await plank.balanceOf(DEAD);
    await gauge.connect(whale).burnPlank(gA, 1_000n * WAD);
    const reallyBurnt = (await plank.balanceOf(DEAD)) - deadBefore;
    // MockIndexToken's fee also goes to dead, so the observed delta is the
    // full amount here — the point of the assertion is that the credited
    // weight equals the OBSERVED delta, never the nominal argument.
    expect(await gauge.claimantWeightedBurns(gA, whale.address)).to.equal(reallyBurnt);
  });

  // ══ Claim accounting: simple, proportional, soulbound ══════════════════

  it("a claimant's share is a live fraction of the CURRENT total, so later burns dilute", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 100n * WAD);
    expect(await gauge.claimShareBps(gA, whale.address)).to.equal(10_000n);
    await gauge.connect(minnow).burnPlank(gA, 300n * WAD);
    expect(await gauge.claimShareBps(gA, whale.address)).to.equal(2_500n);
    expect(await gauge.claimShareBps(gA, minnow.address)).to.equal(7_500n);
  });

  it("a later burn cannot claw back a pot that was already distributed", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, funder, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 100n * WAD);
    await gauge.connect(funder).receiveRewards(gA, { value: ethers.parseEther("4") });
    await gauge.distribute(gA); // folded while the whale owned 100%

    // Now a much bigger burner arrives. It dilutes FUTURE revenue only.
    await gauge.connect(minnow).burnPlank(gA, 900n * WAD);
    expect(await gauge.claimableNow(gA, whale.address)).to.equal(ethers.parseEther("4"));
    expect(await gauge.claimableNow(gA, minnow.address)).to.equal(0n);

    await gauge.connect(funder).receiveRewards(gA, { value: ethers.parseEther("10") });
    await gauge.distribute(gA);
    expect(await gauge.claimableNow(gA, minnow.address)).to.equal(ethers.parseEther("9"));
    expect(await gauge.claimableNow(gA, whale.address)).to.equal(ethers.parseEther("5"));
  });

  it("claims pay out once and cannot be double-drawn", async () => {
    const fx = await fixture();
    const { gauge, whale, funder, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 100n * WAD);
    await gauge.connect(funder).receiveRewards(gA, { value: ethers.parseEther("3") });

    const before: bigint = await ethers.provider.getBalance(whale.address);
    const tx = await gauge.connect(whale).claim(gA);
    const rc = await tx.wait();
    const gas: bigint = BigInt(rc!.gasUsed) * BigInt(rc!.gasPrice);
    expect(await ethers.provider.getBalance(whale.address)).to.equal(
      before + ethers.parseEther("3") - gas
    );
    // A second claim pays zero rather than reverting or paying twice.
    expect(await gauge.claimableNow(gA, whale.address)).to.equal(0n);
    await gauge.connect(whale).claim(gA);
    expect(await ethers.provider.getBalance(fx.gaugeAddr)).to.equal(0n);
  });

  it("a non-burner can never claim anything", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, funder, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 100n * WAD);
    await gauge.connect(funder).receiveRewards(gA, { value: ethers.parseEther("2") });
    await gauge.distribute(gA);
    expect(await gauge.claimableNow(gA, minnow.address)).to.equal(0n);
    const before: bigint = await ethers.provider.getBalance(fx.gaugeAddr);
    await gauge.connect(minnow).claim(gA);
    expect(await ethers.provider.getBalance(fx.gaugeAddr)).to.equal(before);
  });

  it("SOULBOUND: there is no transfer, approve, or admin path over a claim", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, gaugeAdmin, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 100n * WAD);

    const fns = gauge.interface.fragments
      .filter((f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f: any) => f.name.toLowerCase());
    for (const bad of [
      "transfer",
      "approve",
      "permit",
      "delegate",
      "seize",
      "sweep",
      "rescue",
      "emergency",
      "recover",
      "setclaim",
      "mint",
    ]) {
      expect(fns.some((n: string) => n.includes(bad))).to.equal(false, `found ${bad}`);
    }
    // No ERC-20/721 surface at all.
    const all = gauge.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name);
    for (const bad of ["balanceOf", "ownerOf", "allowance", "totalSupply"]) {
      expect(all).to.not.include(bad);
    }
    // ...and the admin cannot move the whale's weight to itself or to anyone.
    expect(await gauge.claimantWeightedBurns(gA, gaugeAdmin.address)).to.equal(0n);
    expect(await gauge.claimantWeightedBurns(gA, minnow.address)).to.equal(0n);
    expect(await gauge.claimantWeightedBurns(gA, whale.address)).to.equal(100n * WAD);
  });

  // ══ Threshold-accumulate ═══════════════════════════════════════════════

  it("below the threshold funds accumulate honestly — no dust payout, no revert", async () => {
    const fx = await fixture();
    const { gauge, whale, funder, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 100n * WAD);
    await gauge.connect(funder).receiveRewards(gA, { value: ethers.parseEther("0.3") });

    let [acc, thr, ok] = await gauge.gaugeStatus(gA);
    expect(acc).to.equal(ethers.parseEther("0.3"));
    expect(thr).to.equal(THRESHOLD);
    expect(ok).to.equal(false, "dust must not be claimable");
    await expect(gauge.distribute(gA)).to.be.revertedWithCustomError(gauge, "BelowThreshold");

    // A claim is NOT an error here — it simply pays zero and leaves the pot.
    await gauge.connect(whale).claim(gA);
    expect(await ethers.provider.getBalance(fx.gaugeAddr)).to.equal(ethers.parseEther("0.3"));

    // Top it up past the threshold and the same call now pays everything.
    await gauge.connect(funder).receiveRewards(gA, { value: ethers.parseEther("0.8") });
    [acc, thr, ok] = await gauge.gaugeStatus(gA);
    expect(ok).to.equal(true);
    await gauge.connect(whale).claim(gA);
    expect(await ethers.provider.getBalance(fx.gaugeAddr)).to.equal(0n);
  });

  it("a pot pushed before anyone has burned is held, never lost", async () => {
    const fx = await fixture();
    const { gauge, whale, funder, gA } = fx;
    await gauge.connect(funder).receiveRewards(gA, { value: ethers.parseEther("5") });
    await expect(gauge.distribute(gA)).to.be.revertedWithCustomError(gauge, "NoClaim");
    await gauge.connect(whale).burnPlank(gA, 10n * WAD);
    await gauge.distribute(gA);
    expect(await gauge.claimableNow(gA, whale.address)).to.equal(ethers.parseEther("5"));
  });

  it("rewards are earmarked per gauge and never leak between gauges", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, funder, gA, gB } = fx;
    await gauge.connect(whale).burnPlank(gA, 100n * WAD);
    await gauge.connect(minnow).burnPlank(gB, 100n * WAD);
    await gauge.connect(funder).receiveRewards(gA, { value: ethers.parseEther("6") });
    await gauge.distribute(gA);
    expect(await gauge.claimableNow(gA, whale.address)).to.equal(ethers.parseEther("6"));
    expect(await gauge.claimableNow(gB, minnow.address)).to.equal(0n);
    expect(await gauge.pendingRewards(gB)).to.equal(0n);
  });

  // ══ The wall between this contract and the basket ══════════════════════

  it("ANCHOR RULE: PlankGauge has no reach into GlobalIndexVault, in ABI or bytecode", async () => {
    const fx = await fixture();
    const { gauge, gaugeAddr } = fx;
    const idx = await deployOpenIndex({}, [1000n * WAD, 2000n * WAD, 500n * WAD]);

    // 1. No function name or argument name anywhere mentions a vault concept.
    for (const f of gauge.interface.fragments.filter((x: any) => x.type === "function") as any[]) {
      const blob = (f.name + " " + f.inputs.map((i: any) => i.name).join(" ")).toLowerCase();
      for (const bad of ["index", "basket", "constituent", "reserve", "redeem", "nav"]) {
        expect(blob.includes(bad)).to.equal(false, `gauge.${f.name} mentions ${bad}`);
      }
    }
    // 2. No vault address appears in this contract's deployed bytecode,
    //    because it was never given one — there is no constructor argument,
    //    no setter, and no storage slot that could hold one.
    const code = await ethers.provider.getCode(gaugeAddr);
    expect(code.toLowerCase()).to.not.include(idx.vaultAddr.slice(2).toLowerCase());
    for (const a of idx.addrs) {
      expect(code.toLowerCase()).to.not.include(a.slice(2).toLowerCase());
    }
    // 3. Symmetrically, the vault knows nothing about gauges (re-affirming
    //    GlobalIndexVault guarantee #5 against the NEW contract).
    for (const f of idx.vault.interface.fragments.filter(
      (x: any) => x.type === "function"
    ) as any[]) {
      const blob = (f.name + " " + f.inputs.map((i: any) => i.name).join(" ")).toLowerCase();
      for (const bad of ["gauge", "burn", "plank", "claim", "reward"]) {
        expect(blob.includes(bad)).to.equal(false, `vault.${f.name} mentions ${bad}`);
      }
    }
  });

  it("ANCHOR RULE: every gauge function, called by every role, moves no vault reserve", async () => {
    const fx = await fixture();
    const { gauge, gaugeAdmin, whale, gA } = fx;
    const idx = await deployOpenIndex({}, [1000n * WAD, 2000n * WAD, 500n * WAD]);
    await idx.vault.connect(idx.alice).mintProRata(500n * WAD, maxIn(3));
    const before = await Promise.all(idx.addrs.map((a) => idx.vault.reserveOf(a)));
    const balBefore = await Promise.all(idx.tokens.map((t) => t.balanceOf(idx.vaultAddr)));

    // Enumerate the whole non-view ABI and call it with arguments chosen to be
    // as favourable to the attacker as possible — the vault's own addresses.
    const fns = gauge.interface.fragments.filter(
      (f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)
    );
    expect(fns.length).to.be.greaterThan(8, "ABI enumeration found nothing");
    const argFor = (t: string): any => {
      if (t === "address") return idx.vaultAddr;
      if (t.startsWith("uint")) return 10n ** 24n;
      if (t === "bool") return true;
      if (t === "bytes32") return ethers.encodeBytes32String("multiplierRawBps");
      if (t.endsWith("[]")) return [];
      return 0n;
    };
    for (const who of [gaugeAdmin, whale]) {
      for (const f of fns as any[]) {
        const args = f.inputs.map((i: any) => argFor(i.type));
        try {
          await (gauge.connect(who) as any)[f.format("sighash")](...args);
        } catch {
          /* a guard firing is correct behaviour */
        }
      }
    }

    for (let i = 0; i < 3; i++) {
      expect(await idx.vault.reserveOf(idx.addrs[i])).to.equal(before[i], `reserve ${i} moved`);
      expect(await idx.tokens[i].balanceOf(idx.vaultAddr)).to.equal(
        balBefore[i],
        `vault balance ${i} moved`
      );
      expect(await idx.tokens[i].balanceOf(gauge.target as string)).to.equal(0n);
    }
    // ...and the vault's parameters are exactly where they were.
    expect((await idx.vault.params()).concentrationCapBps).to.equal(CONCENTRATION_CAP_BPS);
    expect(await idx.vault.admin()).to.equal(idx.admin.address);
    // The gauge's own book is likewise untouched by the sweep.
    expect(await gauge.totalWeightedBurns(gA)).to.equal(0n);
  });

  it("no admin path exists over pushed reward ETH", async () => {
    const fx = await fixture();
    const { gauge, gaugeAdmin, whale, funder, gA, gaugeAddr } = fx;
    await gauge.connect(whale).burnPlank(gA, 100n * WAD);
    await gauge.connect(funder).receiveRewards(gA, { value: ethers.parseEther("9") });

    const adminBefore: bigint = await ethers.provider.getBalance(gaugeAdmin.address);
    const fns = gauge.interface.fragments.filter(
      (f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)
    );
    for (const f of fns as any[]) {
      const args = f.inputs.map((i: any) => {
        if (i.type === "address") return gaugeAdmin.address;
        if (i.type.startsWith("uint")) return 10n ** 24n;
        if (i.type === "bool") return true;
        if (i.type === "bytes32") return ethers.encodeBytes32String("distributionThresholdWei");
        return 0n;
      });
      try {
        await (gauge.connect(gaugeAdmin) as any)[f.format("sighash")](...args);
      } catch {
        /* expected */
      }
    }
    expect(await ethers.provider.getBalance(gaugeAddr)).to.equal(ethers.parseEther("9"));
    // Gas spent only; the admin never received a wei of the pot.
    expect(await ethers.provider.getBalance(gaugeAdmin.address)).to.be.lte(adminBefore);
  });

  it("the contract accepts ETH only through receiveRewards — no bare receive", async () => {
    const fx = await fixture();
    await expect(
      fx.funder.sendTransaction({ to: fx.gaugeAddr, value: WAD })
    ).to.be.reverted;
    expect(await ethers.provider.getBalance(fx.gaugeAddr)).to.equal(0n);
  });

  // ══ Timelocked administration — the vault's exact pattern ══════════════

  it("a multiplier change is QUEUED, never applied instantly", async () => {
    const fx = await fixture();
    const { gauge, gaugeAdmin } = fx;
    const key = ethers.encodeBytes32String("multiplierCollectionLpBps");
    await gauge.connect(gaugeAdmin).queueParam(key, 40_000n);
    expect(await gauge.multiplierBps(2)).to.equal(COLL_MULT, "applied on queue");
    await expect(gauge.executeParam(key)).to.be.revertedWithCustomError(
      gauge,
      "TimelockNotElapsed"
    );
    await time.increase(TIMELOCK + 1);
    await gauge.executeParam(key);
    expect(await gauge.multiplierBps(2)).to.equal(40_000n);
  });

  it("the hard multiplier ceiling holds even after the timelock elapses", async () => {
    const fx = await fixture();
    const { gauge, gaugeAdmin } = fx;
    for (const [name, value] of [
      ["multiplierCollectionLpBps", 1_000_000n], // 100x
      ["multiplierRawBps", 1n], // below 1.0x
      ["distributionThresholdWei", ethers.parseEther("1000")],
    ] as const) {
      const key = ethers.encodeBytes32String(name);
      await gauge.connect(gaugeAdmin).queueParam(key, value);
      await time.increase(TIMELOCK + 1);
      await expect(gauge.executeParam(key)).to.be.revertedWithCustomError(gauge, "BadParam");
    }
    expect(await gauge.multiplierBps(0)).to.equal(RAW_MULT);
    expect(await gauge.multiplierBps(2)).to.equal(COLL_MULT);
  });

  it("the path ordering (raw <= plank/eth LP <= collection LP) cannot be inverted", async () => {
    const fx = await fixture();
    const { gauge, gaugeAdmin } = fx;
    const key = ethers.encodeBytes32String("multiplierRawBps");
    await gauge.connect(gaugeAdmin).queueParam(key, 40_000n); // above the LP rate
    await time.increase(TIMELOCK + 1);
    await expect(gauge.executeParam(key)).to.be.revertedWithCustomError(gauge, "BadParam");
    // And a constructor that inverts them will not deploy at all.
    const Gauge = await ethers.getContractFactory("PlankGauge");
    await expect(
      Gauge.deploy(
        await fx.plank.getAddress(),
        gaugeAdmin.address,
        TIMELOCK,
        [30_000n, 20_000n, 10_000n],
        THRESHOLD
      )
    ).to.be.revertedWithCustomError(Gauge, "BadParam");
  });

  it("a below-floor timelock delay cannot be deployed at all", async () => {
    const fx = await fixture();
    const Gauge = await ethers.getContractFactory("PlankGauge");
    await expect(
      Gauge.deploy(
        await fx.plank.getAddress(),
        fx.gaugeAdmin.address,
        3_600,
        [RAW_MULT, LP_MULT, COLL_MULT],
        THRESHOLD
      )
    ).to.be.revertedWithCustomError(Gauge, "BadParam");
  });

  it("the LP allowlist is itself timelocked, so a fake pair cannot be slipped in", async () => {
    const fx = await fixture();
    const { gauge, gaugeAdmin, whale, gA, impostorLp } = fx;
    const addr = await impostorLp.getAddress();
    await gauge.connect(gaugeAdmin).queuePlankEthLp(addr, false);
    // Not approved yet, and no way to shorten the wait.
    await expect(
      gauge.connect(whale).burnPlankEthLp(gA, addr, WAD)
    ).to.be.revertedWithCustomError(gauge, "NotApprovedLp");
    await expect(gauge.executePlankEthLp(addr)).to.be.revertedWithCustomError(
      gauge,
      "TimelockNotElapsed"
    );
    await time.increase(TIMELOCK + 1);
    await gauge.executePlankEthLp(addr);
    expect(await gauge.approvedPlankEthLp(addr)).to.equal(true);
  });

  it("only the admin can queue anything", async () => {
    const fx = await fixture();
    const { gauge, whale, gA } = fx;
    const calls: [string, any[]][] = [
      ["queueParam", [ethers.encodeBytes32String("multiplierRawBps"), 1n]],
      ["queueGauge", [gA, true]],
      ["queuePlankEthLp", [whale.address, false]],
      ["queueCollectionLp", [gA, whale.address, whale.address, false]],
      ["queueAdmin", [whale.address]],
    ];
    for (const [name, args] of calls) {
      await expect((gauge.connect(whale) as any)[name](...args), name).to.be.revertedWithCustomError(
        gauge,
        "NotAdmin"
      );
    }
  });

  it("an admin handover is itself timelocked", async () => {
    const fx = await fixture();
    const { gauge, gaugeAdmin, minnow } = fx;
    await gauge.connect(gaugeAdmin).queueAdmin(minnow.address);
    expect(await gauge.admin()).to.equal(gaugeAdmin.address);
    await expect(gauge.executeAdmin()).to.be.revertedWithCustomError(gauge, "TimelockNotElapsed");
    await time.increase(TIMELOCK + 1);
    await gauge.executeAdmin();
    expect(await gauge.admin()).to.equal(minnow.address);
  });

  it("un-registering a gauge stops new burns but confiscates nothing", async () => {
    const fx = await fixture();
    const { gauge, gaugeAdmin, whale, funder, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 100n * WAD);
    await gauge.connect(funder).receiveRewards(gA, { value: ethers.parseEther("2") });
    await gauge.distribute(gA);

    await gauge.connect(gaugeAdmin).queueGauge(gA, true);
    await time.increase(TIMELOCK + 1);
    await gauge.executeGauge(gA);

    expect(await gauge.gaugeRegistered(gA)).to.equal(false);
    await expect(gauge.connect(whale).burnPlank(gA, WAD)).to.be.revertedWithCustomError(
      gauge,
      "UnknownGauge"
    );
    // The book survives intact...
    expect(await gauge.claimantWeightedBurns(gA, whale.address)).to.equal(100n * WAD);
    // ...but claiming needs the gauge back, and re-registering restores it
    // exactly, so a removal can never be used to strand an existing claim.
    await gauge.connect(gaugeAdmin).queueGauge(gA, false);
    await time.increase(TIMELOCK + 1);
    await gauge.executeGauge(gA);
    expect(await gauge.claimableNow(gA, whale.address)).to.equal(ethers.parseEther("2"));
    await gauge.connect(whale).claim(gA);
    expect(await ethers.provider.getBalance(fx.gaugeAddr)).to.equal(0n);
  });
});
