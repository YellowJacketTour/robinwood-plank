import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { deployBeaconMock } from "./helpers/beacon.js";

/**
 * Explicit pool activation — replaces the old fixed-ETH bootstrap threshold.
 *
 * Model: the vault deploys CLOSED. The treasury seeds shares and ETH at its
 * own pace, across any number of calls, in any order. Nobody can trade
 * (buyShares/sellShares both revert PoolNotOpen) until the treasury calls
 * openPool() — a one-way, permanent switch that requires only the basic
 * sanity floor of a non-empty pool on BOTH sides (there is no magic minimum;
 * "enough" is entirely the treasury's judgement, expressed by choosing when
 * to call it). Once open:
 *   - trading is publicly accessible forever,
 *   - seedLiquidity()/seedShares() revert forever, for everyone,
 *   - openPool() itself can never be called again.
 *
 * The documented "stranded pool" recovery (ETH seeded alone with zero shares)
 * stays naturally recoverable: openPool() refuses a zero-share pool, so the
 * seeding window — including seedShares — is still open in exactly that state.
 */
describe("MarketplankVault — explicit one-way pool activation", () => {
  const SHARE_UNIT = 10n ** 18n;

  async function deploy() {
    const [deployer, treasury, alice] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const beacon: any = await deployBeaconMock();
    const Vault = await ethers.getContractFactory("MarketplankVault");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "V",
      "V",
      0n, // no mint fee: treasury keeps clean whole shares for seeding
      0n,
      0n,
      treasury.address,
      await beacon.getAddress()
    );
    return { deployer, treasury, alice, nft, vault };
  }

  async function depositOne(nft: any, vault: any, who: any, tokenId: number) {
    await nft.mint(who.address, tokenId);
    await nft.connect(who).approve(await vault.getAddress(), tokenId);
    await vault.connect(who).deposit(tokenId);
  }

  it("deploys closed and exposes poolOpen", async () => {
    const { vault } = await deploy();
    expect(await vault.poolOpen()).to.equal(false);
  });

  it("openPool() reverts for any non-treasury caller", async () => {
    const { deployer, treasury, alice, nft, vault } = await deploy();
    // Even with a fully seeded, perfectly openable pool.
    await depositOne(nft, vault, treasury, 1);
    await vault.connect(treasury).seedShares(SHARE_UNIT, { value: ethers.parseEther("1") });
    for (const who of [deployer, alice]) {
      await expect(vault.connect(who).openPool()).to.be.revertedWithCustomError(
        vault,
        "NotTreasury"
      );
    }
    expect(await vault.poolOpen()).to.equal(false);
  });

  it("openPool() reverts on an empty pool: zero shares, zero ETH, or both", async () => {
    // Case 1: both sides empty (fresh deploy).
    const a = await deploy();
    await expect(a.vault.connect(a.treasury).openPool()).to.be.revertedWithCustomError(
      a.vault,
      "EmptyVault"
    );

    // Case 2: ETH but zero shares — the documented stranded state.
    const b = await deploy();
    await b.vault.connect(b.treasury).seedLiquidity({ value: ethers.parseEther("5") });
    await expect(b.vault.connect(b.treasury).openPool()).to.be.revertedWithCustomError(
      b.vault,
      "EmptyVault"
    );

    // Case 3: shares but zero ETH.
    const c = await deploy();
    await depositOne(c.nft, c.vault, c.treasury, 1);
    await c.vault.connect(c.treasury).seedShares(SHARE_UNIT);
    expect(await c.vault.ethReserve()).to.equal(0n);
    await expect(c.vault.connect(c.treasury).openPool()).to.be.revertedWithCustomError(
      c.vault,
      "EmptyVault"
    );
  });

  it("seeding works in any order across many calls before openPool(); no threshold ever blocks it", async () => {
    const { treasury, nft, vault } = await deploy();
    // Interleave liquidity and share seeding, big and dust amounts alike —
    // there is no target to cross, so nothing ever locks mid-bootstrap.
    await vault.connect(treasury).seedLiquidity({ value: ethers.parseEther("3") });
    await depositOne(nft, vault, treasury, 1);
    await depositOne(nft, vault, treasury, 2);
    await vault.connect(treasury).seedShares(SHARE_UNIT / 2n, { value: ethers.parseEther("1") });
    await vault.connect(treasury).seedLiquidity({ value: 1n });
    await vault.connect(treasury).seedShares(SHARE_UNIT, { value: 0n });
    await vault.connect(treasury).seedLiquidity({ value: ethers.parseEther("100") });
    expect(await vault.ethReserve()).to.equal(ethers.parseEther("104") + 1n);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal((SHARE_UNIT * 3n) / 2n);
    expect(await vault.poolOpen()).to.equal(false);
  });

  it("stranded-pool recovery: ETH seeded alone stays recoverable via seedShares", async () => {
    const { treasury, alice, nft, vault } = await deploy();

    // The documented stranding mistake: ETH in, no shares ever seeded.
    await vault.connect(treasury).seedLiquidity({ value: ethers.parseEther("10") });
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);

    // The pool cannot be opened in this state (proven above), therefore the
    // seeding window is necessarily still open — confirm the recovery call
    // actually works rather than assuming it.
    await expect(vault.connect(treasury).openPool()).to.be.revertedWithCustomError(
      vault,
      "EmptyVault"
    );
    await depositOne(nft, vault, treasury, 1);
    await vault.connect(treasury).seedShares(SHARE_UNIT);

    // Now openable, and the pool functions.
    await vault.connect(treasury).openPool();
    await vault.connect(alice).buyShares(0n, { value: ethers.parseEther("1") });
  });

  it("buyShares/sellShares revert PoolNotOpen before opening, even with non-zero reserves", async () => {
    const { treasury, alice, nft, vault } = await deploy();
    await depositOne(nft, vault, treasury, 1);
    await depositOne(nft, vault, alice, 2);
    await vault.connect(treasury).seedShares(SHARE_UNIT, { value: ethers.parseEther("2") });

    // Both reserves are demonstrably non-zero…
    expect(await vault.ethReserve()).to.be.gt(0n);
    expect(await vault.balanceOf(await vault.getAddress())).to.be.gt(0n);

    // …and the public still cannot trade in either direction.
    await expect(
      vault.connect(alice).buyShares(0n, { value: ethers.parseEther("1") })
    ).to.be.revertedWithCustomError(vault, "PoolNotOpen");
    await expect(
      vault.connect(alice).sellShares(SHARE_UNIT / 2n, 0n)
    ).to.be.revertedWithCustomError(vault, "PoolNotOpen");
    // The treasury is gated exactly like everyone else.
    await expect(
      vault.connect(treasury).buyShares(0n, { value: 1n })
    ).to.be.revertedWithCustomError(vault, "PoolNotOpen");
  });

  it("after openPool(): trading works, seeding is dead forever for everyone, all argument shapes", async () => {
    const { treasury, alice, nft, vault } = await deploy();
    await depositOne(nft, vault, treasury, 1);
    await depositOne(nft, vault, alice, 2);
    await vault.connect(treasury).seedShares(SHARE_UNIT, { value: ethers.parseEther("2") });

    await expect(vault.connect(treasury).openPool()).to.emit(vault, "PoolOpened");
    expect(await vault.poolOpen()).to.equal(true);

    // Both swap directions now work normally.
    await vault.connect(alice).buyShares(0n, { value: ethers.parseEther("1") });
    const bought: bigint = await vault.balanceOf(alice.address);
    expect(bought).to.be.gt(SHARE_UNIT); // her deposit share + the buy
    await vault.connect(alice).sellShares(bought / 2n, 0n);

    // Treasury seeding: both functions, with and without value, zero-value.
    await expect(vault.connect(treasury).seedLiquidity()).to.be.revertedWithCustomError(
      vault,
      "BootstrapComplete"
    );
    await expect(
      vault.connect(treasury).seedLiquidity({ value: ethers.parseEther("100") })
    ).to.be.revertedWithCustomError(vault, "BootstrapComplete");
    await expect(vault.connect(treasury).seedShares(0n)).to.be.revertedWithCustomError(
      vault,
      "BootstrapComplete"
    );
    await expect(
      vault.connect(treasury).seedShares(SHARE_UNIT, { value: ethers.parseEther("1") })
    ).to.be.revertedWithCustomError(vault, "BootstrapComplete");

    // Everyone else is (still) blocked too — NotTreasury fires first, but the
    // point pinned here is simply: no caller, no argument shape, ever seeds.
    await expect(vault.connect(alice).seedLiquidity({ value: 1n })).to.be.revert(ethers);
    await expect(vault.connect(alice).seedLiquidity()).to.be.revert(ethers);
    await expect(vault.connect(alice).seedShares(0n)).to.be.revert(ethers);
    await expect(vault.connect(alice).seedShares(SHARE_UNIT, { value: 1n })).to.be.revert(ethers);
  });

  it("openPool() is one-way: a second call reverts, even for the treasury", async () => {
    const { treasury, nft, vault } = await deploy();
    await depositOne(nft, vault, treasury, 1);
    await vault.connect(treasury).seedShares(SHARE_UNIT, { value: ethers.parseEther("1") });
    await vault.connect(treasury).openPool();
    await expect(vault.connect(treasury).openPool()).to.be.revertedWithCustomError(
      vault,
      "PoolAlreadyOpen"
    );
    expect(await vault.poolOpen()).to.equal(true);
  });
});
