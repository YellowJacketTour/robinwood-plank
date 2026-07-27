import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Audit regression tests — each of these encodes a specific vulnerability
 * found during the 2026-07-27 adversarial review. They must all pass; if one
 * ever fails again, the corresponding exploit is live.
 */
describe("MarketplankVault — audit regressions", () => {
  const SHARE_UNIT = 10n ** 18n;

  async function deploy() {
    const [deployer, treasury, alice, attacker] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const Vault = await ethers.getContractFactory("MarketplankVault");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "V",
      "V",
      100n, // 1% mint
      100n, // 1% redeem
      250n, // 2.5% target premium
      treasury.address
    );
    return { deployer, treasury, alice, attacker, nft, vault };
  }

  async function depositOne(nft: any, vault: any, who: any, tokenId: number) {
    await nft.mint(who.address, tokenId);
    await nft.connect(who).approve(await vault.getAddress(), tokenId);
    await vault.connect(who).deposit(tokenId);
  }

  it("FINDING 1 (critical): empty share reserve cannot drain the ETH pool", async () => {
    const { treasury, alice, attacker, nft, vault } = await deploy();

    // Treasury seeds ETH. No shares have been placed in the pool yet.
    await vault.connect(treasury).seedLiquidity({ value: ethers.parseEther("5") });
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);

    // Attacker acquires a tiny amount of shares by depositing one NFT.
    await depositOne(nft, vault, attacker, 1);

    // The exploit: sell a dust amount of shares against a zero share reserve.
    // Pre-fix this returned the ENTIRE ethReserve for 1 wei of shares.
    await expect(vault.connect(attacker).sellShares(1n, 0n)).to.be.revertedWithCustomError(
      vault,
      "EmptyVault"
    );

    // Pool ETH is untouched.
    expect(await vault.ethReserve()).to.equal(ethers.parseEther("5"));
  });

  it("FINDING 2 (critical): redemptions never mint claims the vault cannot honor", async () => {
    const { treasury, alice, nft, vault } = await deploy();

    // Two NFTs in, two full shares of backing.
    await depositOne(nft, vault, alice, 1);
    await depositOne(nft, vault, alice, 2);

    const held = await vault.heldTokenCount();
    const supply = await vault.totalSupply();
    // Solvency invariant: every share in existence is backed by an NFT.
    expect(supply).to.equal(held * SHARE_UNIT);

    // Redeem one targeted. Pre-fix, redemption minted a fee without burning
    // an equivalent amount, leaving more share-claims than NFTs forever.
    await vault.connect(alice).redeemTarget(1);

    expect(await vault.totalSupply()).to.equal((await vault.heldTokenCount()) * SHARE_UNIT);
  });

  it("FINDING 3: zero-output swaps revert instead of silently taking funds", async () => {
    const { treasury, alice, nft, vault } = await deploy();
    await depositOne(nft, vault, alice, 1);
    await vault.connect(alice).transfer(await vault.getAddress(), SHARE_UNIT / 2n);
    await vault.connect(treasury).seedLiquidity({ value: ethers.parseEther("1") });

    // 1 wei of ETH rounds to 0 shares out — must revert, not pocket the wei.
    await expect(vault.connect(alice).buyShares(0n, { value: 1n })).to.be.revertedWithCustomError(
      vault,
      "InsufficientOutput"
    );
  });

  it("FINDING 4: only the treasury can seed pool liquidity", async () => {
    const { attacker, vault } = await deploy();
    await expect(
      vault.connect(attacker).seedLiquidity({ value: ethers.parseEther("1") })
    ).to.be.revertedWithCustomError(vault, "NotTreasury");
  });

  it("FINDING 5 (high): a contract cannot draw and act on a random redeem in one tx", async () => {
    const { alice, nft, vault } = await deploy();

    // Fund an attacker contract with enough shares to redeem.
    const Attacker = await ethers.getContractFactory("MockRerollAttacker");
    const attackerC: any = await Attacker.deploy(await vault.getAddress());
    for (const id of [1, 2, 3, 4]) await depositOne(nft, vault, alice, id);
    await vault.connect(alice).transfer(await attackerC.getAddress(), SHARE_UNIT * 2n);

    // The reroll attack: commit and claim inside one transaction, so the
    // caller could inspect the drawn token and revert if it wasn't rare.
    // The committed block has no hash yet, so this is unreachable.
    await expect(attackerC.commitAndClaimSameTx()).to.be.revertedWithCustomError(
      vault,
      "TooSoon"
    );

    // Split across blocks it works, and the shares were burned at commit —
    // so abandoning an unwanted draw costs the full share, never free.
    await attackerC.commit();
    const supplyAfterCommit = await vault.totalSupply();
    await ethers.provider.send("evm_mine", []);
    await attackerC.claim();

    expect(await vault.totalSupply()).to.equal(supplyAfterCommit);
    expect(await vault.totalSupply()).to.equal((await vault.heldTokenCount()) * SHARE_UNIT);
  });

  it("FINDING 6 (high): a pending random redemption cannot be starved by targeted redeems", async () => {
    // Deployed with zero fees on purpose. With fees on, the fee buffer means
    // the system never has enough shares outstanding to redeem every NFT, so
    // held == pending is unreachable and the guard can't be exercised. Zeroing
    // fees isolates the guard itself, which has to be correct regardless of
    // whether the fee schedule happens to make the state reachable.
    const [, treasury, alice, attacker] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const Vault = await ethers.getContractFactory("MarketplankVault");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "V",
      "V",
      0n,
      0n,
      0n,
      treasury.address
    );

    await depositOne(nft, vault, alice, 1);
    await depositOne(nft, vault, alice, 2);

    // Alice commits: one NFT is now spoken for, her shares already burned.
    await vault.connect(alice).requestRandomRedeem();
    expect(await vault.pendingRedeemCount()).to.equal(1n);

    // She takes the one genuinely unreserved NFT.
    await vault.connect(alice).redeemTarget(2);
    expect(await vault.heldTokenCount()).to.equal(1n);

    // The last NFT backs her pending draw. Targeting it must fail — this is
    // the check that stops an already-paid-for redemption being stranded.
    await expect(vault.connect(attacker).redeemTarget(1)).to.be.revertedWithCustomError(
      vault,
      "ReservedForPendingRedeem"
    );

    // And she can still claim it.
    await ethers.provider.send("evm_mine", []);
    await vault.connect(alice).claimRandomRedeem();
    expect(await vault.pendingRedeemCount()).to.equal(0n);
    expect(await vault.heldTokenCount()).to.equal(0n);
  });

  it("solvency invariant holds across a randomized sequence of operations", async () => {
    const { treasury, alice, attacker, nft, vault } = await deploy();
    let nextId = 1;

    const check = async () => {
      const supply: bigint = await vault.totalSupply();
      const held: bigint = await vault.heldTokenCount();
      const pending: bigint = await vault.pendingRedeemCount();
      expect(supply + pending * SHARE_UNIT).to.equal(held * SHARE_UNIT);
    };

    for (const who of [alice, attacker, alice, attacker, alice, alice]) {
      await depositOne(nft, vault, who, nextId++);
      await check();
    }

    await vault.connect(alice).redeemTarget(1);
    await check();

    await vault.connect(attacker).requestRandomRedeem();
    await check();
    await ethers.provider.send("evm_mine", []);
    await vault.connect(attacker).claimRandomRedeem();
    await check();

    // Pool activity must not disturb the invariant either.
    await vault.connect(alice).transfer(await vault.getAddress(), SHARE_UNIT);
    await vault.connect(treasury).seedLiquidity({ value: ethers.parseEther("2") });
    await check();
    await vault.connect(attacker).buyShares(0n, { value: ethers.parseEther("0.1") });
    await check();
    const bal: bigint = await vault.balanceOf(attacker.address);
    await vault.connect(attacker).sellShares(bal / 2n, 0n);
    await check();
  });
});
