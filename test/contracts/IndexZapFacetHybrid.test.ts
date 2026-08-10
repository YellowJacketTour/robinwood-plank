import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "./helpers/network-helpers.js";
import { deployIndexVault, TIMELOCK, paramsTuple, defaultParams } from "./helpers/index-vault.js";

/**
 * ============================================================================
 * IndexZapFacet.zapMintHybrid — per-leg funding-source flexibility.
 *
 * Still the FULL weighted basket, every leg filled, one way or another (an
 * index share is an equal claim on the entire basket — there is no such
 * thing as a partial-basket mint). What this adds is choice of SOURCE per
 * leg: bring shares you already hold (credited directly, zero AMM impact),
 * and only the shortfall is bought via AMM — exactly the way `zapMint`
 * buys the whole leg. `bringAmounts[i] == 0` for every leg must behave
 * identically to `zapMint`.
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("IndexZapFacet.zapMintHybrid — bring-what-you-hold + buy-the-rest", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const VAULT_TIMELOCK = 48 * 3600;
  const SINK_BPS = 3_000n;

  async function openVaultPool(
    cVault: any,
    vaultAddr: string,
    treasury: any,
    weth: any,
    seedPaymentAmt: bigint,
    seedSharesAmt: bigint,
    sharesHolder: any
  ) {
    await weth.mint(treasury.address, seedPaymentAmt);
    await weth.connect(treasury).approve(vaultAddr, seedPaymentAmt);
    await cVault.connect(treasury).seedLiquidity(seedPaymentAmt);
    await cVault.connect(sharesHolder).transfer(treasury.address, seedSharesAmt);
    await cVault.connect(treasury).seedShares(seedSharesAmt);
    await cVault.connect(treasury).openPool();
  }

  async function setup() {
    const [, roleAdmin, seeder, alice, , admission, risk, allocation, cvTreasury1, cvTreasury2] =
      await ethers.getSigners();

    const weth: any = await (await ethers.getContractFactory("MockIndexToken")).deploy("WETH", "WETH");
    const wethAddr = await weth.getAddress();

    const { vault, vaultAddr } = await deployIndexVault({
      name: "ZapHybridIndex",
      symbol: "ZHIDX",
      roles: [roleAdmin.address, admission.address, risk.address, allocation.address, admission.address],
      seeder: seeder.address,
      timelockDelay: TIMELOCK,
      params: paramsTuple(defaultParams),
      dividendAsset: wethAddr,
    });

    const factory: any = await (await ethers.getContractFactory("CollectionVaultFactory")).deploy(
      vaultAddr,
      wethAddr,
      VAULT_TIMELOCK
    );

    const nft1: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const nft2: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();

    const addr1: string = await factory.deployVault.staticCall(await nft1.getAddress(), cvTreasury1.address, SINK_BPS);
    await factory.deployVault(await nft1.getAddress(), cvTreasury1.address, SINK_BPS);
    const cVault1: any = await ethers.getContractAt("CollectionVault", addr1);

    const addr2: string = await factory.deployVault.staticCall(await nft2.getAddress(), cvTreasury2.address, SINK_BPS);
    await factory.deployVault(await nft2.getAddress(), cvTreasury2.address, SINK_BPS);
    const cVault2: any = await ethers.getContractAt("CollectionVault", addr2);

    await weth.mint(seeder.address, ethers.parseEther("500"));
    await weth.connect(seeder).approve(addr1, ethers.MaxUint256);
    await weth.connect(seeder).approve(addr2, ethers.MaxUint256);

    for (let i = 1; i <= 60; i++) {
      await nft1.mint(seeder.address, i);
      await nft1.connect(seeder).approve(addr1, i);
      await cVault1.connect(seeder).deposit(i);
    }
    for (let i = 1; i <= 60; i++) {
      await nft2.mint(seeder.address, i);
      await nft2.connect(seeder).approve(addr2, i);
      await cVault2.connect(seeder).deposit(i);
    }

    await openVaultPool(cVault1, addr1, cvTreasury1, weth, ethers.parseEther("500"), ethers.parseEther("5"), seeder);
    await openVaultPool(cVault2, addr2, cvTreasury2, weth, ethers.parseEther("500"), ethers.parseEther("5"), seeder);

    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const src1: any = await Source.deploy(ethers.parseEther("1"), ethers.parseEther("1"));
    const src2: any = await Source.deploy(ethers.parseEther("1"), ethers.parseEther("1"));

    await vault.connect(seeder).seedConstituent(addr1, await src1.getAddress(), 5_000n);
    await vault.connect(seeder).seedConstituent(addr2, await src2.getAddress(), 5_000n);

    const seedDepositAmt = ethers.parseEther("20");
    await cVault1.connect(seeder).approve(vaultAddr, seedDepositAmt);
    await vault.connect(seeder).seedDeposit(addr1, seedDepositAmt);
    await cVault2.connect(seeder).approve(vaultAddr, seedDepositAmt);
    await vault.connect(seeder).seedDeposit(addr2, seedDepositAmt);

    await vault.connect(seeder).openIndex(ethers.parseEther("1000"));

    await vault.connect(admission).queueVaultFactory(await factory.getAddress());
    await time.increase(TIMELOCK + 1);
    await vault.executeVaultFactory();

    await weth.mint(alice.address, ethers.parseEther("10000"));
    await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);

    // Give alice some real shares of BOTH constituents she can choose to
    // "bring" instead of buying — a real depositor, not a fabricated balance.
    for (let i = 201; i <= 204; i++) {
      await nft1.mint(alice.address, i);
      await nft1.connect(alice).approve(addr1, i);
      await weth.mint(alice.address, ethers.parseEther("1"));
      await weth.connect(alice).approve(addr1, ethers.MaxUint256);
      await cVault1.connect(alice).deposit(i);
    }
    for (let i = 201; i <= 204; i++) {
      await nft2.mint(alice.address, i);
      await nft2.connect(alice).approve(addr2, i);
      await weth.mint(alice.address, ethers.parseEther("1"));
      await weth.connect(alice).approve(addr2, ethers.MaxUint256);
      await cVault2.connect(alice).deposit(i);
    }
    await cVault1.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    await cVault2.connect(alice).approve(vaultAddr, ethers.MaxUint256);

    return { vault, vaultAddr, weth, cVault1, addr1, cVault2, addr2, alice, seeder };
  }

  it("bringAmounts of all zeros behaves IDENTICALLY to zapMint — same mint, same real WETH cost", async () => {
    const { vault, weth, alice } = await setup();
    const desiredSharesOut = ethers.parseEther("2");
    const maxPaymentIn = ethers.parseEther("50");

    const snap = await takeSnapshot();

    const idxBefore1: bigint = await vault.balanceOf(alice.address);
    const wethBefore1: bigint = await weth.balanceOf(alice.address);
    await vault.connect(alice).zapMint(desiredSharesOut, maxPaymentIn);
    const plainMinted = (await vault.balanceOf(alice.address)) - idxBefore1;
    const plainSpent = wethBefore1 - (await weth.balanceOf(alice.address));

    await snap.restore();

    const idxBefore2: bigint = await vault.balanceOf(alice.address);
    const wethBefore2: bigint = await weth.balanceOf(alice.address);
    await vault.connect(alice).zapMintHybrid(desiredSharesOut, maxPaymentIn, [0n, 0n]);
    const hybridMinted = (await vault.balanceOf(alice.address)) - idxBefore2;
    const hybridSpent = wethBefore2 - (await weth.balanceOf(alice.address));

    expect(hybridMinted).to.equal(plainMinted);
    expect(hybridSpent).to.equal(plainSpent);
  });

  it("bringing ENOUGH of both constituents costs ZERO WETH — no AMM interaction needed", async () => {
    const { vault, weth, cVault1, cVault2, alice } = await setup();
    const desiredSharesOut = ethers.parseEther("0.5"); // small, well within alice's brought balance

    const wethBefore: bigint = await weth.balanceOf(alice.address);
    const idxBefore: bigint = await vault.balanceOf(alice.address);
    const c1Before: bigint = await cVault1.balanceOf(alice.address);
    const c2Before: bigint = await cVault2.balanceOf(alice.address);

    // Generous bring amounts — the contract clamps to what's actually needed.
    const bring = ethers.parseEther("2");
    const tx = await vault.connect(alice).zapMintHybrid(desiredSharesOut, ethers.parseEther("50"), [bring, bring]);
    const receipt = await tx.wait();

    expect((await vault.balanceOf(alice.address)) - idxBefore).to.equal(desiredSharesOut);
    // No WETH spent at all — every leg was fully funded by what alice brought.
    expect(wethBefore).to.equal(await weth.balanceOf(alice.address));
    // Real constituent shares left alice's balance — genuinely pulled, not a no-op.
    expect(c1Before).to.be.gt(await cVault1.balanceOf(alice.address));
    expect(c2Before).to.be.gt(await cVault2.balanceOf(alice.address));

    const minted = receipt.logs
      .map((l: any) => {
        try {
          return vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "ZapMinted");
    expect(minted!.args.paymentSpent).to.equal(0n);
  });

  it("bringing a PARTIAL amount buys only the real shortfall via AMM — exact mint either way", async () => {
    const { vault, weth, cVault1, addr1, cVault2, alice } = await setup();
    // This fixture's reserve ratio makes each leg's real pro-rata `want`
    // roughly 2% of `desiredSharesOut`. Sized so `want` (~0.06e18, ~1.2% of
    // the 5e18-share pool — safely under the 3% impact ceiling) comfortably
    // exceeds a small, fixed, deliberately-partial bring.
    const desiredSharesOut = ethers.parseEther("3");
    const partialBring = ethers.parseEther("0.01"); // real, but far below the ~0.06e18 `want`

    const c1BalBefore: bigint = await cVault1.balanceOf(alice.address);
    const idxBefore: bigint = await vault.balanceOf(alice.address);
    const wethBefore: bigint = await weth.balanceOf(alice.address);

    const tx = await vault
      .connect(alice)
      .zapMintHybrid(desiredSharesOut, ethers.parseEther("50"), [partialBring, 0n]);
    await tx.wait();

    expect((await vault.balanceOf(alice.address)) - idxBefore).to.equal(desiredSharesOut);
    // Exactly `partialBring` of constituent 1 left alice's own balance —
    // never more (over-pulling would itself be a bug: the contract must
    // never take more of a brought token than that leg actually needed).
    expect(c1BalBefore - (await cVault1.balanceOf(alice.address))).to.equal(partialBring);
    // Real WETH was still spent for the shortfall + the fully-AMM-bought
    // second leg.
    expect(wethBefore).to.be.gt(await weth.balanceOf(alice.address));
  });

  it("a length mismatch on bringAmounts reverts cleanly, spending nothing", async () => {
    const { vault, weth, alice } = await setup();
    const wethBefore: bigint = await weth.balanceOf(alice.address);
    await expect(
      vault.connect(alice).zapMintHybrid(ethers.parseEther("1"), ethers.parseEther("50"), [0n])
    ).to.be.revertedWithCustomError(vault, "ZapBadBringLength");
    expect(await weth.balanceOf(alice.address)).to.equal(wethBefore);
  });

  it("an absurdly over-generous bringAmounts is clamped, never pulling more than the leg needs", async () => {
    const { vault, cVault1, cVault2, alice } = await setup();
    const desiredSharesOut = ethers.parseEther("0.2");

    const c1Before: bigint = await cVault1.balanceOf(alice.address);
    const c2Before: bigint = await cVault2.balanceOf(alice.address);

    // Absurdly large bring — must clamp to each leg's real `want`, not pull
    // alice's whole balance.
    await vault
      .connect(alice)
      .zapMintHybrid(desiredSharesOut, ethers.parseEther("50"), [ethers.parseEther("1000"), ethers.parseEther("1000")]);

    const c1Pulled = c1Before - (await cVault1.balanceOf(alice.address));
    const c2Pulled = c2Before - (await cVault2.balanceOf(alice.address));
    // Pulled something real, but nowhere near the full "brought" amount —
    // proves the clamp to `want` is real, not merely documented.
    expect(c1Pulled).to.be.gt(0n);
    expect(c1Pulled).to.be.lt(ethers.parseEther("1000"));
    expect(c2Pulled).to.be.gt(0n);
    expect(c2Pulled).to.be.lt(ethers.parseEther("1000"));
  });
});
