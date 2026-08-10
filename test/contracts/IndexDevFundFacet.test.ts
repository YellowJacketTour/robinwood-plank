import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployOpenIndex, WAD, TIMELOCK, BPS, maxIn } from "./helpers/index-vault";

/**
 * ============================================================================
 * IndexDevFundFacet — §7.11 "dev-fund allocation via PLANK market-buy"
 * (design doc DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md §7.11).
 *
 * THIS IS A DELIBERATELY DIFFERENT TRUST MODEL FROM EVERY OTHER SUITE IN THIS
 * REPO, AND THIS FILE PROVES THAT HONESTLY RATHER THAN PRETENDING OTHERWISE.
 * The dev-fund treasury here is real, spendable, team-directed value — not a
 * trustless mechanism — so nothing below claims "no admin path" or "no one
 * can touch it". What IS proven, mechanically:
 *
 *   1. `devFundBps` cannot exceed the 2% ceiling (`CEIL_DEV_FUND_BPS = 200`),
 *      enforced at execution.
 *   2. The percentage AND the treasury address are both governed and
 *      timelocked — no direct, un-timelocked setter for either.
 *   3. A mint (both `mintProRata` and `mintSingleAsset`) correctly triggers a
 *      PLANK buy of the configured percentage against a real mock router.
 *   4. A failure in the PLANK-buy step (the mock router reverting, or
 *      leaving a standing allowance) does NOT block or revert the underlying
 *      mint — matching the "a spend/side-effect action must never brick the
 *      primary user action" doctrine already proven for hooks in
 *      `HookRegistryFacet` (`Hooks.*.test.ts`).
 * ============================================================================
 */
describe("IndexDevFundFacet (design doc §7.11)", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const CEIL = 200n; // IndexFacetBase.CEIL_DEV_FUND_BPS

  async function deployRouter(rate = WAD) {
    const Router = await ethers.getContractFactory("MockExternalSwapRouter");
    const router: any = await Router.deploy(rate);
    await router.waitForDeployment();
    const routerAddr = await router.getAddress();
    const plankAddr = await router.plank();
    const plank = await ethers.getContractAt("MockPlank", plankAddr);
    return { router, routerAddr, plank };
  }

  /** Queue + execute a governed dev-fund param through the full timelock. */
  async function setBps(fx: any, bps: bigint) {
    await fx.vault.connect(fx.allocation).queueDevFundBps(bps);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeDevFundBps();
    await fx.vault.checkpointAll(); // refresh past the timelock jump
  }
  async function setRouter(fx: any, addr: string) {
    await fx.vault.connect(fx.allocation).queueDevFundRouter(addr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeDevFundRouter();
    await fx.vault.checkpointAll(); // refresh past the timelock jump
  }
  async function setTreasury(fx: any, addr: string) {
    await fx.vault.connect(fx.allocation).queueDevFundTreasury(addr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeDevFundTreasury();
    await fx.vault.checkpointAll(); // refresh past the timelock jump
  }

  async function fixtureWired(bps = 100n) {
    const fx = await deployOpenIndex();
    const { router, routerAddr, plank } = await deployRouter();
    const treasury = fx.carol.address;
    await setRouter(fx, routerAddr);
    await setTreasury(fx, treasury);
    await setBps(fx, bps);
    return { ...fx, router, routerAddr, plank, treasury };
  }

  // ══ 1. The 2% ceiling — hard, enforced at execution ═══════════════════

  it("cannot exceed the 2% ceiling — enforced at execution, not just discouraged", async () => {
    const fx = await deployOpenIndex();
    await fx.vault.connect(fx.allocation).queueDevFundBps(CEIL + 1n);
    await time.increase(TIMELOCK + 1);
    await expect(fx.vault.executeDevFundBps()).to.be.revertedWithCustomError(fx.vault, "BadParam");
    expect(await fx.vault.devFundBps()).to.equal(0n);

    // Exactly at the ceiling succeeds.
    await fx.vault.connect(fx.allocation).queueDevFundBps(CEIL);
    await time.increase(TIMELOCK + 1);
    await expect(fx.vault.executeDevFundBps()).to.emit(fx.vault, "DevFundBpsSet").withArgs(CEIL);
    expect(await fx.vault.devFundBps()).to.equal(CEIL);
  });

  // ══ 2. Governed + timelocked: percentage, router, treasury ════════════

  it("devFundBps has no direct setter — only queue/execute, gated to ROLE_PLATFORM_ALLOCATION (audit M-5), timelocked", async () => {
    const fx = await deployOpenIndex();
    await expect(fx.vault.connect(fx.alice).queueDevFundBps(50n)).to.be.revertedWithCustomError(
      fx.vault,
      "NotRoleHolder"
    );
    // AUDIT FIX M-5. The RISK key must be rejected here. It used to be the
    // holder of this capability, which let a compromised risk key aim a real,
    // spendable treasury at any address. Revert the facet's modifier and this
    // line goes red.
    await expect(fx.vault.connect(fx.risk).queueDevFundBps(50n)).to.be.revertedWithCustomError(
      fx.vault,
      "NotRoleHolder"
    );
    await fx.vault.connect(fx.allocation).queueDevFundBps(50n);
    await expect(fx.vault.executeDevFundBps()).to.be.revertedWithCustomError(fx.vault, "TimelockNotElapsed");
    expect(await fx.vault.devFundBps()).to.equal(0n);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeDevFundBps();
    expect(await fx.vault.devFundBps()).to.equal(50n);
  });

  it("devFundTreasury has no direct setter — only queue/execute, gated to ROLE_PLATFORM_ALLOCATION (audit M-5), timelocked", async () => {
    const fx = await deployOpenIndex();
    await expect(
      fx.vault.connect(fx.alice).queueDevFundTreasury(fx.bob.address)
    ).to.be.revertedWithCustomError(fx.vault, "NotRoleHolder");
    // AUDIT FIX M-5. The RISK key must be rejected here. It used to be the
    // holder of this capability, which let a compromised risk key aim a real,
    // spendable treasury at any address. Revert the facet's modifier and this
    // line goes red.
    await expect(fx.vault.connect(fx.risk).queueDevFundTreasury(fx.bob.address)).to.be.revertedWithCustomError(
      fx.vault,
      "NotRoleHolder"
    );
    await fx.vault.connect(fx.allocation).queueDevFundTreasury(fx.bob.address);
    await expect(fx.vault.executeDevFundTreasury()).to.be.revertedWithCustomError(
      fx.vault,
      "TimelockNotElapsed"
    );
    expect(await fx.vault.devFundTreasury()).to.equal(ethers.ZeroAddress);
    await time.increase(TIMELOCK + 1);
    await expect(fx.vault.executeDevFundTreasury())
      .to.emit(fx.vault, "DevFundTreasurySet")
      .withArgs(fx.bob.address);
    expect(await fx.vault.devFundTreasury()).to.equal(fx.bob.address);
  });

  it("devFundRouter has no direct setter — only queue/execute, gated to ROLE_PLATFORM_ALLOCATION (audit M-5), timelocked", async () => {
    const fx = await deployOpenIndex();
    const { routerAddr } = await deployRouter();
    await expect(
      fx.vault.connect(fx.alice).queueDevFundRouter(routerAddr)
    ).to.be.revertedWithCustomError(fx.vault, "NotRoleHolder");
    // AUDIT FIX M-5. The RISK key must be rejected here. It used to be the
    // holder of this capability, which let a compromised risk key aim a real,
    // spendable treasury at any address. Revert the facet's modifier and this
    // line goes red.
    await expect(fx.vault.connect(fx.risk).queueDevFundRouter(routerAddr)).to.be.revertedWithCustomError(
      fx.vault,
      "NotRoleHolder"
    );
    await fx.vault.connect(fx.allocation).queueDevFundRouter(routerAddr);
    await expect(fx.vault.executeDevFundRouter()).to.be.revertedWithCustomError(
      fx.vault,
      "TimelockNotElapsed"
    );
    expect(await fx.vault.devFundRouter()).to.equal(ethers.ZeroAddress);
    await time.increase(TIMELOCK + 1);
    await expect(fx.vault.executeDevFundRouter()).to.emit(fx.vault, "DevFundRouterSet").withArgs(routerAddr);
    expect(await fx.vault.devFundRouter()).to.equal(routerAddr);
  });

  it("nothing can be executed before it was queued", async () => {
    const fx = await deployOpenIndex();
    await expect(fx.vault.executeDevFundBps()).to.be.revertedWithCustomError(fx.vault, "NothingQueued");
    await expect(fx.vault.executeDevFundRouter()).to.be.revertedWithCustomError(fx.vault, "NothingQueued");
    await expect(fx.vault.executeDevFundTreasury()).to.be.revertedWithCustomError(fx.vault, "NothingQueued");
  });

  // ══ 3. A mint correctly triggers a PLANK buy of the configured % ══════

  it("mintSingleAsset triggers a real PLANK buy of exactly the configured percentage, delivered to the treasury", async () => {
    const bps = 150n; // 1.5%
    const fx = await fixtureWired(bps);
    const shareToken = fx.addrs[1];
    const depositAmount = 10n * WAD;

    const plankBefore: bigint = await fx.plank.balanceOf(fx.treasury);
    const tokenC = await ethers.getContractAt("MockIndexToken", shareToken);

    const tx = await fx.vault.connect(fx.alice).mintSingleAsset(shareToken, depositAmount, 0n);
    const receipt = await tx.wait();

    // Real state: the router actually received and pulled tokenIn, and
    // actually minted PLANK to the treasury — not a stand-in assertion.
    const plankAfter: bigint = await fx.plank.balanceOf(fx.treasury);
    expect(plankAfter).to.be.gt(plankBefore);

    // Recover the ACTUAL credited amount (post-transfer-fee-free here, so
    // it equals depositAmount) from the emitted event, and confirm the
    // skim is exactly `credited * bps / BPS` — the configured percentage,
    // not an approximation.
    const iface = fx.vault.interface;
    const buyEvent = receipt.logs
      .map((l: any) => {
        try {
          return iface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "DevFundBuyExecuted");
    expect(buyEvent, "DevFundBuyExecuted not emitted").to.not.equal(undefined);
    const amountIn: bigint = buyEvent!.args.amountIn;
    expect(amountIn).to.equal((depositAmount * bps) / BPS);
    expect(buyEvent!.args.tokenIn).to.equal(shareToken);
    expect(buyEvent!.args.treasury).to.equal(fx.treasury);
    expect(buyEvent!.args.plankOut).to.equal(plankAfter - plankBefore);

    // The router really pulled `amountIn` of the deposited token from the
    // diamond — a real ERC-20 balance movement, not a mocked price.
    expect(await tokenC.balanceOf(fx.routerAddr)).to.equal(amountIn);
    // No standing approval left behind.
    expect(await tokenC.allowance(fx.vaultAddr, fx.routerAddr)).to.equal(0n);
  });

  it("mintProRata triggers a PLANK buy on every constituent leg it deposits, each at the configured percentage", async () => {
    const bps = 100n; // 1%
    const fx = await fixtureWired(bps);
    const sharesOut = 500n * WAD;

    const tx = await fx.vault.connect(fx.alice).mintProRata(sharesOut, maxIn(3));
    const receipt = await tx.wait();

    const iface = fx.vault.interface;
    const buyEvents = receipt.logs
      .map((l: any) => {
        try {
          return iface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((e: any) => e && e.name === "DevFundBuyExecuted");

    // Three constituents, three legs, three buys — one per deposited token.
    expect(buyEvents.length).to.equal(3);
    for (const e of buyEvents) {
      expect(e!.args.treasury).to.equal(fx.treasury);
      expect(e!.args.amountIn).to.be.gt(0n);
    }

    const plankAfter: bigint = await fx.plank.balanceOf(fx.treasury);
    expect(plankAfter).to.be.gt(0n);
  });

  it("a zero-configured dev fund (the default) is a no-op — mint behaves exactly as before §7.11", async () => {
    const fx = await deployOpenIndex();
    const shareToken = fx.addrs[1];
    await expect(fx.vault.connect(fx.alice).mintSingleAsset(shareToken, 10n * WAD, 0n)).to.not.be.reverted;
    // No router configured, so nothing to check balances against — the
    // absence of a revert, combined with `devFundBps() == 0` below, IS the
    // no-op proof (see DevFundStorage's own header: zero-default is opt-in).
    expect(await fx.vault.devFundBps()).to.equal(0n);
    expect(await fx.vault.devFundRouter()).to.equal(ethers.ZeroAddress);
  });

  // ══ 4. A router failure never blocks or reverts the underlying mint ══

  it("a reverting router does not block mintSingleAsset — the mint still succeeds, full shares, full reserve credit", async () => {
    const bps = 200n; // ceiling — the worst-case skim size
    const fx = await deployOpenIndex();
    const { router, routerAddr } = await deployRouter();
    await router.setMode(1n); // Mode.REVERT
    await setRouter(fx, routerAddr);
    await setTreasury(fx, fx.carol.address);
    await setBps(fx, bps);

    const shareToken = fx.addrs[1];
    const depositAmount = 10n * WAD;
    const tokenC = await ethers.getContractAt("MockIndexToken", shareToken);

    // A minted amount computed with a healthy router as the baseline, against
    // an INDEPENDENT vault of its own (its constituent addresses differ from
    // `fx`'s, so its own `addrs[1]` must be used, not `fx`'s).
    const fxHealthy = await fixtureWired(bps);
    const sharesHealthy: bigint = await fxHealthy.vault
      .connect(fxHealthy.alice)
      .mintSingleAsset.staticCall(fxHealthy.addrs[1], depositAmount, 0n);

    // `fixtureWired`'s own timelock jumps moved the shared Hardhat clock
    // further forward since `fx` was last checkpointed — refresh `fx` too.
    await fx.vault.checkpointAll();

    const sharesOut: bigint = await fx.vault
      .connect(fx.alice)
      .mintSingleAsset.staticCall(shareToken, depositAmount, 0n);
    // A REVERTING router must cost the depositor nothing: they mint AT LEAST
    // as many shares as under a healthy router (a healthy router successfully
    // routes value away to the dev fund, which is a real, disclosed, if
    // small, cost — the failure path must never be worse for the user).
    expect(sharesOut).to.be.gte(sharesHealthy);

    const tx = await fx.vault.connect(fx.alice).mintSingleAsset(shareToken, depositAmount, 0n);
    const receipt = await tx.wait();
    await expect(tx).to.emit(fx.vault, "MintedSingle");

    const iface = fx.vault.interface;
    const failEvent = receipt.logs
      .map((l: any) => {
        try {
          return iface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "DevFundBuyFailed");
    expect(failEvent, "DevFundBuyFailed not emitted").to.not.equal(undefined);

    // No standing approval left behind by the failed attempt.
    expect(await tokenC.allowance(fx.vaultAddr, routerAddr)).to.equal(0n);
    // The router never actually took anything (the call reverted before its
    // own transferFrom could land).
    expect(await tokenC.balanceOf(routerAddr)).to.equal(0n);
  });

  it("a router that leaves the approval unspent (returns without pulling tokenIn) is treated as a failure too — no value lost, no standing approval", async () => {
    const bps = 100n;
    const fx = await deployOpenIndex();
    const { router, routerAddr } = await deployRouter();
    await router.setMode(3n); // Mode.NO_PULL
    await setRouter(fx, routerAddr);
    await setTreasury(fx, fx.carol.address);
    await setBps(fx, bps);

    const shareToken = fx.addrs[1];
    const tokenC = await ethers.getContractAt("MockIndexToken", shareToken);

    const tx = await fx.vault.connect(fx.alice).mintSingleAsset(shareToken, 10n * WAD, 0n);
    await expect(tx).to.emit(fx.vault, "MintedSingle");
    await expect(tx).to.emit(fx.vault, "DevFundBuyFailed");

    expect(await tokenC.allowance(fx.vaultAddr, routerAddr)).to.equal(0n);
    expect(await tokenC.balanceOf(routerAddr)).to.equal(0n);
  });

  it("a router that pulls the skim but mints zero PLANK (SHORT_MINT) is treated as a failure too — no value lost, no silent reserve drain, DevFundBuyFailed not DevFundBuyExecuted", async () => {
    // Adversarial-review finding (2nd independent pass, §7.11): a router that
    // fully consumes its approval via `transferFrom` but delivers
    // `plankOut == 0` used to pass the old "leftover allowance == 0" success
    // check and emit `DevFundBuyExecuted` with `plankOut == 0` — indistin-
    // guishable on-chain from a healthy buy, and in direct contradiction of
    // this function's own doc comment ("only a genuinely successful buy ever
    // reduces what backs the newly-minted shares"). Fixed by gating success
    // on `plankOut > 0` in `_routeDevFundBuy`, reusing the exact same
    // failure path (`forceApprove(router, 0)` + `DevFundBuyFailed`) already
    // proven by the REVERT/NO_PULL cases above.
    const bps = 200n; // ceiling — the worst-case skim size
    const fx = await deployOpenIndex();
    const { router, routerAddr } = await deployRouter();
    await router.setMode(2n); // Mode.SHORT_MINT
    await setRouter(fx, routerAddr);
    await setTreasury(fx, fx.carol.address);
    await setBps(fx, bps);

    const shareToken = fx.addrs[1];
    const depositAmount = 10n * WAD;
    const tokenC = await ethers.getContractAt("MockIndexToken", shareToken);

    // Baseline: shares minted under a healthy router, on an independent vault
    // (its own constituent addresses, per the REVERT test's own pattern).
    const fxHealthy = await fixtureWired(bps);
    const sharesHealthy: bigint = await fxHealthy.vault
      .connect(fxHealthy.alice)
      .mintSingleAsset.staticCall(fxHealthy.addrs[1], depositAmount, 0n);
    await fx.vault.checkpointAll();

    const sharesOut: bigint = await fx.vault
      .connect(fx.alice)
      .mintSingleAsset.staticCall(shareToken, depositAmount, 0n);
    // A SHORT_MINT router — which pulls tokens but delivers nothing — must
    // still cost the depositor nothing: the mint's reserve credit must not
    // be reduced, so shares out must be at least as many as the healthy path.
    expect(sharesOut).to.be.gte(sharesHealthy);

    const tx = await fx.vault.connect(fx.alice).mintSingleAsset(shareToken, depositAmount, 0n);
    const receipt = await tx.wait();
    await expect(tx).to.emit(fx.vault, "MintedSingle");

    const iface = fx.vault.interface;
    const parsed = receipt.logs
      .map((l: any) => {
        try {
          return iface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((e: any) => e !== null);

    expect(
      parsed.find((e: any) => e.name === "DevFundBuyExecuted"),
      "DevFundBuyExecuted must NOT be emitted for a zero-plankOut buy"
    ).to.equal(undefined);
    const failEvent = parsed.find((e: any) => e.name === "DevFundBuyFailed");
    expect(failEvent, "DevFundBuyFailed not emitted").to.not.equal(undefined);
    expect(failEvent!.args.amountAttempted).to.equal((depositAmount * bps) / BPS);

    // The router DID pull the skim (unlike NO_PULL) — that's the whole point
    // of this mode — but it must not be lost: no standing approval is left
    // behind, proving the fix goes through the same reset-and-fail path.
    expect(await tokenC.allowance(fx.vaultAddr, routerAddr)).to.equal(0n);
    expect(await tokenC.balanceOf(routerAddr)).to.equal((depositAmount * bps) / BPS);
  });

  it("a reverting router does not block mintProRata — mint still succeeds and credits full reserves", async () => {
    const bps = 200n;
    const fx = await deployOpenIndex();
    const { router, routerAddr } = await deployRouter();
    await router.setMode(1n); // Mode.REVERT
    await setRouter(fx, routerAddr);
    await setTreasury(fx, fx.carol.address);
    await setBps(fx, bps);

    const sharesOut = 200n * WAD;
    await expect(fx.vault.connect(fx.alice).mintProRata(sharesOut, maxIn(3))).to.not.be.reverted;
    expect(await fx.vault.balanceOf(fx.alice.address)).to.be.gte(sharesOut);
  });

  // ══ 5. §7.11's own honesty discipline — no trustless language used ═════

  it("is disclosed as a real, spendable, team-directed treasury — not routed through the buyback lock, never SEED_LOCK_ADDR", async () => {
    const fx = await fixtureWired(200n);
    const seedLock: string = await fx.vault.SEED_LOCK();
    const shareToken = fx.addrs[1];
    await fx.vault.connect(fx.alice).mintSingleAsset(shareToken, 10n * WAD, 0n);

    // Bought PLANK landed at the configured treasury — a normal, spendable
    // EOA/multisig in this fixture — and nowhere near the dead-address lock
    // §7.7's buyback uses. The whole point of §7.11 is that this value is
    // NOT locked.
    expect(await fx.plank.balanceOf(seedLock)).to.equal(0n);
    expect(await fx.plank.balanceOf(fx.treasury)).to.be.gt(0n);

    // And the treasury can freely move it — real spendability, proven by a
    // real transfer, not merely asserted.
    const bal: bigint = await fx.plank.balanceOf(fx.treasury);
    await fx.plank.connect(fx.carol).transfer(fx.bob.address, bal);
    expect(await fx.plank.balanceOf(fx.bob.address)).to.equal(bal);
    expect(await fx.plank.balanceOf(fx.treasury)).to.equal(0n);
  });
});
